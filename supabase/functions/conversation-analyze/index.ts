import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { safeDecryptToken } from "../_shared/encryption.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Extraction prompt ──────────────────────────────────────────
const EXTRACTION_PROMPT = `You are a sales intelligence extraction engine for a multi-tenant B2B SaaS platform.

Your task is to analyze a WhatsApp or email conversation and extract structured sales intelligence.

IMPORTANT: This extraction must produce durable intelligence that remains useful AFTER the raw message text is deleted (72-hour retention policy). Be specific and self-contained — do NOT reference "the message" or "the text above" in your outputs.

Return a JSON object using the tool provided. Every field is required.

Field definitions:
- intent: The primary intent of the latest inbound message(s). One of: inquiry, pricing_request, demo_request, objection, follow_up, scheduling, support, complaint, ghosting, not_clear
- objections: Array of specific objections raised (empty array if none). Each should be a self-contained statement.
- buying_signals: Array of positive buying indicators detected (empty array if none). Each should be self-contained.
- deal_stage: Estimated deal stage. One of: awareness, interest, evaluation, negotiation, decision, closed_won, closed_lost, stalled
- sentiment: Overall sentiment. One of: very_positive, positive, neutral, negative, very_negative
- urgency: Urgency level. One of: critical, high, medium, low, none
- ghosting_risk: Risk the contact will stop responding. One of: high, medium, low
- ghosting_risk_reason: One sentence explaining the ghosting risk assessment.
- recommended_reply_channel: Best channel for the next reply. One of: whatsapp, email
- channel_reason: One sentence explaining why this channel is recommended.
- summary_short: A self-contained 2-sentence summary of the conversation state. Must make sense without seeing the original messages.
- topics: Array of 1-5 topic tags (e.g. "pricing", "integration", "timeline", "security", "compliance")
- key_facts: Array of durable facts extracted (e.g. "Budget approved for Q2", "Decision maker is CTO", "Using competitor X currently"). These persist after messages are deleted.

Context you will receive:
1. Latest message text (may be a single message or batch)
2. Conversation history (if available within 72h cache)
3. Contact metadata (company, status, prior analysis if any)
4. Prior analysis (the last extraction, if one exists)`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // Auth: require a valid user JWT or the service role key
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const isServiceRole = token === serviceRoleKey;

  if (!isServiceRole) {
    // Validate as user JWT
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { conversation_id, workspace_id } = body;

  if (!conversation_id || !workspace_id) {
    return new Response(
      JSON.stringify({ error: "conversation_id and workspace_id required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // ── 1. Fetch conversation metadata ─────────────────────────
    const { data: conversation, error: convErr } = await supabase
      .from("conversations")
      .select("id, contact_id, channel, owner_user_id, status, message_count")
      .eq("id", conversation_id)
      .eq("workspace_id", workspace_id)
      .single();

    if (convErr || !conversation) {
      return new Response(
        JSON.stringify({ error: "Conversation not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 2. Fetch contact metadata ──────────────────────────────
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, display_name, company, status, last_activity_at")
      .eq("id", conversation.contact_id)
      .single();

    // ── 3. Fetch messages within 72h window (not yet expired) ──
    const { data: messages } = await supabase
      .from("messages")
      .select("id, direction, body_ciphertext, media_type, created_at")
      .eq("conversation_id", conversation_id)
      .eq("workspace_id", workspace_id)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(50);

    // Decrypt message bodies
    const decryptedMessages: Array<{
      direction: string;
      text: string;
      media_type: string | null;
      timestamp: string;
    }> = [];

    if (messages && messages.length > 0) {
      for (const msg of messages) {
        let text = "";
        if (msg.body_ciphertext) {
          try {
            text = await safeDecryptToken(msg.body_ciphertext);
          } catch {
            text = "[encrypted - unable to decrypt]";
          }
        }
        decryptedMessages.push({
          direction: msg.direction,
          text,
          media_type: msg.media_type,
          timestamp: msg.created_at,
        });
      }
    }

    // ── 4. Fetch prior analysis for context continuity ─────────
    const { data: priorAnalysis } = await supabase
      .from("conversation_analysis")
      .select("summary_short, summary_text, extracted_features, sentiment, topics, urgency")
      .eq("conversation_id", conversation_id)
      .eq("workspace_id", workspace_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // ── 5. Build the user prompt ───────────────────────────────
    const contactContext = contact
      ? `Contact: ${contact.display_name ?? "Unknown"} | Company: ${contact.company ?? "Unknown"} | Status: ${contact.status}`
      : "Contact: Unknown";

    const messageHistory = decryptedMessages.length > 0
      ? decryptedMessages
          .map((m) => `[${m.direction}] (${m.timestamp}) ${m.text}${m.media_type ? ` [${m.media_type}]` : ""}`)
          .join("\n")
      : "No messages available (may have expired).";

    const priorContext = priorAnalysis
      ? `Prior Analysis:\n- Summary: ${priorAnalysis.summary_short ?? priorAnalysis.summary_text ?? "N/A"}\n- Sentiment: ${priorAnalysis.sentiment ?? "N/A"}\n- Topics: ${(priorAnalysis.topics ?? []).join(", ")}\n- Urgency: ${priorAnalysis.urgency ?? "N/A"}\n- Key features: ${JSON.stringify(priorAnalysis.extracted_features ?? {})}`
      : "No prior analysis available.";

    const userPrompt = `${contactContext}

Channel: ${conversation.channel}
Message count: ${conversation.message_count}

--- Conversation History ---
${messageHistory}

--- Prior Analysis ---
${priorContext}

Analyze this conversation and extract the structured sales intelligence.`;

    // ── 6. Call Lovable AI with tool calling ────────────────────
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const aiResponse = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            { role: "system", content: EXTRACTION_PROMPT },
            { role: "user", content: userPrompt },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "extract_sales_intelligence",
                description:
                  "Extract structured sales intelligence features from a conversation.",
                parameters: {
                  type: "object",
                  properties: {
                    intent: {
                      type: "string",
                      enum: [
                        "inquiry", "pricing_request", "demo_request", "objection",
                        "follow_up", "scheduling", "support", "complaint", "ghosting", "not_clear",
                      ],
                    },
                    objections: {
                      type: "array",
                      items: { type: "string" },
                    },
                    buying_signals: {
                      type: "array",
                      items: { type: "string" },
                    },
                    deal_stage: {
                      type: "string",
                      enum: [
                        "awareness", "interest", "evaluation", "negotiation",
                        "decision", "closed_won", "closed_lost", "stalled",
                      ],
                    },
                    sentiment: {
                      type: "string",
                      enum: ["very_positive", "positive", "neutral", "negative", "very_negative"],
                    },
                    urgency: {
                      type: "string",
                      enum: ["critical", "high", "medium", "low", "none"],
                    },
                    ghosting_risk: {
                      type: "string",
                      enum: ["high", "medium", "low"],
                    },
                    ghosting_risk_reason: { type: "string" },
                    recommended_reply_channel: {
                      type: "string",
                      enum: ["whatsapp", "email"],
                    },
                    channel_reason: { type: "string" },
                    summary_short: { type: "string" },
                    topics: {
                      type: "array",
                      items: { type: "string" },
                    },
                    key_facts: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: [
                    "intent", "objections", "buying_signals", "deal_stage",
                    "sentiment", "urgency", "ghosting_risk", "ghosting_risk_reason",
                    "recommended_reply_channel", "channel_reason", "summary_short",
                    "topics", "key_facts",
                  ],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: {
            type: "function",
            function: { name: "extract_sales_intelligence" },
          },
        }),
      }
    );

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("[conversation-analyze] AI gateway error:", aiResponse.status, errText);

      if (aiResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded, please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (aiResponse.status === 402) {
        return new Response(
          JSON.stringify({ error: "Payment required, please add credits." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      throw new Error(`AI gateway returned ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();

    // Extract the tool call result
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.function.name !== "extract_sales_intelligence") {
      throw new Error("AI did not return expected tool call");
    }

    const extracted = JSON.parse(toolCall.function.arguments);

    // ── 7. Determine message window for the analysis ───────────
    const messageWindowStart = decryptedMessages.length > 0
      ? decryptedMessages[0].timestamp
      : null;
    const messageWindowEnd = decryptedMessages.length > 0
      ? decryptedMessages[decryptedMessages.length - 1].timestamp
      : null;

    // ── 8. Store the analysis (permanent) ──────────────────────
    const { data: analysis, error: insertErr } = await supabase
      .from("conversation_analysis")
      .insert({
        workspace_id,
        conversation_id,
        contact_id: conversation.contact_id,
        summary_text: extracted.summary_short,
        summary_short: extracted.summary_short,
        sentiment: extracted.sentiment,
        topics: extracted.topics,
        urgency: extracted.urgency,
        recommended_reply_channel: extracted.recommended_reply_channel,
        extracted_features: {
          intent: extracted.intent,
          objections: extracted.objections,
          buying_signals: extracted.buying_signals,
          deal_stage: extracted.deal_stage,
          ghosting_risk: extracted.ghosting_risk,
          ghosting_risk_reason: extracted.ghosting_risk_reason,
          channel_reason: extracted.channel_reason,
          key_facts: extracted.key_facts,
        },
        model_used: "google/gemini-3-flash-preview",
        message_window_start: messageWindowStart,
        message_window_end: messageWindowEnd,
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("[conversation-analyze] Failed to store analysis:", insertErr);
      throw new Error("Failed to store analysis");
    }

    console.log(
      "[conversation-analyze] Analysis stored:",
      analysis.id,
      "for conversation:",
      conversation_id
    );

    return new Response(
      JSON.stringify({
        ok: true,
        analysis_id: analysis.id,
        extracted,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("[conversation-analyze] Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
