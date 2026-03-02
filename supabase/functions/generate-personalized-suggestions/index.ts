import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // ── Auth ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ suggestions: [] }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableKey = Deno.env.get("LOVABLE_API_KEY")!;

    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !user) return json({ suggestions: [] }, 401);

    const { lead_id, channel, user_draft } = await req.json() as {
      lead_id: string;
      channel: "email" | "whatsapp" | "sms" | "voice";
      user_draft?: string;
    };

    if (!lead_id || !channel) return json({ suggestions: [] }, 400);

    const admin = createClient(supabaseUrl, serviceKey);

    // ── 1) Load lead intelligence ──
    const { data: lead } = await admin
      .from("leads")
      .select("name, company, email, strategy, stage, next_step, next_step_reason, risks_json, milestones_json, personal_notes")
      .eq("id", lead_id)
      .single();

    if (!lead) return json({ suggestions: [] });

    // ── 2) Load enrichment signals (defensive) ──
    // Resolve workspace for the user
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1)
      .single();

    let topSignals: { signal: string; source: string }[] = [];
    if (membership?.workspace_id) {
      const { data: enrichment } = await admin
        .from("entity_enrichment")
        .select("signals")
        .eq("workspace_id", membership.workspace_id)
        .eq("lead_id", lead_id)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (enrichment?.signals && Array.isArray(enrichment.signals)) {
        topSignals = (enrichment.signals as { signal: string; source: string }[]).slice(0, 2);
      }
    }

    // ── 3) Load recent interactions ──
    const { data: interactions } = await admin
      .from("interactions")
      .select("type, subject, ai_summary, direction, occurred_at")
      .eq("lead_id", lead_id)
      .order("occurred_at", { ascending: false })
      .limit(10);

    const recentContext = (interactions ?? [])
      .map((i) => `[${i.type}] ${i.direction ?? ""} ${i.subject ?? ""}: ${i.ai_summary ?? ""}`.trim())
      .join("\n");

    // ── 4) Build deterministic context ──
    const risks = Array.isArray(lead.risks_json) ? (lead.risks_json as any[]).slice(0, 2) : [];
    const milestones = Array.isArray(lead.milestones_json) ? (lead.milestones_json as any[]).slice(0, 2) : [];

    const contextBlock = [
      `Lead: ${lead.name} at ${lead.company}`,
      `Stage: ${lead.stage}`,
      lead.next_step ? `Next step: ${lead.next_step}` : null,
      lead.next_step_reason ? `Why: ${lead.next_step_reason}` : null,
      risks.length > 0 ? `Risks: ${risks.map((r: any) => r.issue).join("; ")}` : null,
      milestones.length > 0 ? `Milestones: ${milestones.map((m: any) => m.description).join("; ")}` : null,
      topSignals.length > 0 ? `Company signals: ${topSignals.map((s) => s.signal).join(", ")}` : null,
      recentContext ? `Recent interactions:\n${recentContext}` : null,
      user_draft ? `User's current draft: ${user_draft}` : null,
    ].filter(Boolean).join("\n");

    // ── 5) Channel-specific prompt ──
    let formatInstruction: string;
    if (channel === "email") {
      formatInstruction = `Return a JSON array of exactly 3 email suggestions. Each must have: {"subject": "...", "body": "..."} where body is 3-6 sentences. No markdown in body.`;
    } else if (channel === "whatsapp" || channel === "sms") {
      formatInstruction = `Return a JSON array of exactly 3 short message suggestions. Each must be: {"text": "..."} where text is 1-2 lines max. Conversational, no formatting.`;
    } else {
      // voice
      formatInstruction = `Return a JSON array of exactly 3 voice talk-track suggestions. Each must be: {"bullets": ["...", "..."]} with 3-5 concise bullet points focusing on objection handling and milestone reminders.`;
    }

    const systemPrompt = `You are a sales AI assistant. Generate exactly 3 personalized ${channel} suggestions for a sales rep.

Context:
${contextBlock}

${formatInstruction}

Rules:
- Be specific to this lead's situation, not generic
- Vary tone across the 3 suggestions (direct, consultative, assertive)
- Reference company signals or milestones when available
- Never invent facts not in the context
- Return valid JSON array only, no markdown fences`;

    // ── 6) Call LLM ──
    const llmRes = await fetch("https://api.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: systemPrompt }],
        temperature: 0.7,
      }),
    });

    if (!llmRes.ok) {
      console.error("LLM call failed:", llmRes.status);
      return json({ suggestions: [] });
    }

    const llmData = await llmRes.json();
    const content = llmData.choices?.[0]?.message?.content ?? "[]";

    let suggestions: unknown[];
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      suggestions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      suggestions = [];
    }

    return json({ suggestions: suggestions.slice(0, 3), channel });
  } catch (err) {
    console.error("[generate-personalized-suggestions] Unhandled error:", err);
    return json({ suggestions: [] });
  }
});
