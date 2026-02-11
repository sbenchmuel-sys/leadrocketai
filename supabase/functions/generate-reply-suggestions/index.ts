import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LOVABLE_AI_URL = "https://ai.lovable.dev/api/generate";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Find conversations with recent inbound messages that need reply suggestions
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // last 2h
    const { data: conversations, error: convErr } = await supabase
      .from("conversations")
      .select("id, contact_id, workspace_id, owner_user_id, channel")
      .eq("status", "open")
      .gte("last_message_at", cutoff);

    if (convErr || !conversations?.length) {
      return new Response(JSON.stringify({ ok: true, generated: 0, reason: "no recent conversations" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let generated = 0;

    for (const convo of conversations) {
      // Check if latest message is inbound (needs reply)
      const { data: latestMsg } = await supabase
        .from("messages")
        .select("id, direction, created_at")
        .eq("conversation_id", convo.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!latestMsg || latestMsg.direction !== "inbound") continue;

      // Get the latest analysis for context
      const { data: analysis } = await supabase
        .from("conversation_analysis")
        .select("summary_short, sentiment, urgency, topics, extracted_features, recommended_reply_channel")
        .eq("conversation_id", convo.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!analysis?.summary_short) continue;

      // Get contact info
      const { data: contact } = await supabase
        .from("contacts")
        .select("display_name, company, status")
        .eq("id", convo.contact_id)
        .maybeSingle();

      const recChannel = analysis.recommended_reply_channel ?? convo.channel;

      const channelGuidance = recChannel === "whatsapp"
        ? `Channel: WhatsApp\nFORMAT RULES:\n- Conversational, friendly tone\n- Keep messages SHORT (2-4 sentences max)\n- No subject line\n- Use natural language, avoid corporate jargon\n- OK to use line breaks for readability`
        : `Channel: Email\nFORMAT RULES:\n- Include a subject line (prefix with "Subject: ")\n- Professional, structured formatting\n- Use paragraphs and proper greeting/sign-off\n- Clear call-to-action`;

      const prompt = `You are a B2B sales assistant. Generate exactly 3 reply drafts for a sales conversation. These are DRAFTS ONLY — they will NOT be sent automatically. The rep will review and edit before sending.

Context:
- Contact: ${contact?.display_name ?? "Unknown"} at ${contact?.company ?? "Unknown"}
- Summary: ${analysis.summary_short}
- Sentiment: ${analysis.sentiment ?? "neutral"}
- Urgency: ${analysis.urgency ?? "medium"}
- Topics: ${(analysis.topics ?? []).join(", ")}
- ${channelGuidance}

Generate 3 drafts with these EXACT styles:
1. "direct" — Short & direct. Get to the point fast. Minimal fluff.
2. "consultative" — Warm & consultative. Ask questions, show empathy, position as advisor.
3. "assertive" — Assertive but professional. Confident, creates urgency without being pushy.

Return a JSON object with this exact structure:
{
  "replies": [
    {"style": "direct", "text": "..."},
    {"style": "consultative", "text": "..."},
    {"style": "assertive", "text": "..."}
  ],
  "recommended_channel": "${recChannel}"
}`;

      try {
        const aiResp = await fetch(LOVABLE_AI_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("LOVABLE_API_KEY")}`,
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
          }),
        });

        if (!aiResp.ok) {
          console.error(`[generate-reply-suggestions] AI call failed for ${convo.id}:`, await aiResp.text());
          continue;
        }

        const aiData = await aiResp.json();
        const content = aiData.choices?.[0]?.message?.content;
        if (!content) continue;

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch {
          console.error("[generate-reply-suggestions] Failed to parse AI response");
          continue;
        }

        // Store in conversation_analysis as part of extracted_features
        const features = (analysis.extracted_features as any) ?? {};
        features.reply_suggestions = parsed.replies;
        features.reply_suggestions_at = new Date().toISOString();
        features.reply_recommended_channel = parsed.recommended_channel;

        await supabase
          .from("conversation_analysis")
          .update({ extracted_features: features })
          .eq("conversation_id", convo.id)
          .order("created_at", { ascending: false })
          .limit(1);

        generated++;
        console.log(`[generate-reply-suggestions] Generated for conversation ${convo.id}`);
      } catch (err) {
        console.error(`[generate-reply-suggestions] Error for ${convo.id}:`, err);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, generated }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[generate-reply-suggestions] Fatal error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
