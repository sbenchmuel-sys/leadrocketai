// ============================================================
// Recompute Lead Intelligence — Canonical intelligence layer
// Aggregates timeline items, conversation analysis, call analysis,
// meeting summaries, and lead metadata into one snapshot.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertLeadAccess, isInternalCaller } from "../_shared/authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");

  // ── Auth ──
  const authHeader = req.headers.get("Authorization") ?? "";
  const isInternal = isInternalCaller(req);
  const admin = createClient(supabaseUrl, serviceKey);

  let userId: string | null = null;
  if (!isInternal) {
    if (!authHeader) return respond({ ok: false, error: "Unauthorized" }, 401);
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error } = await anonClient.auth.getUser();
    if (error || !user) return respond({ ok: false, error: "Unauthorized" }, 401);
    userId = user.id;
  }

  try {
    const { lead_id } = await req.json();
    if (!lead_id) return respond({ ok: false, error: "Missing lead_id" }, 400);

    // ── Authz ──
    if (!isInternal && userId) {
      const check = await assertLeadAccess(admin, lead_id, userId);
      if (!check.ok) return respond({ ok: false, error: check.error }, check.status || 403);
    }

    // ── 1. Fetch lead ──
    const { data: lead } = await admin
      .from("leads")
      .select("id, workspace_id, name, company, email, stage, motion, strategy, status, next_step, next_step_reason, milestones_json, risks_json, deal_factors_json, engagement_score, last_activity_at, nurture_status, nurture_mode")
      .eq("id", lead_id)
      .single();

    if (!lead) return respond({ ok: false, error: "Lead not found" }, 404);

    const workspaceId = lead.workspace_id;
    if (!workspaceId) return respond({ ok: false, error: "Lead has no workspace" }, 400);

    // ── 2. Parallel fetch all evidence sources ──
    const [timelineRes, convoAnalysisRes, callAnalysisRes, meetingRes] = await Promise.all([
      // Timeline items (last 30)
      admin.from("lead_timeline_items")
        .select("channel, direction, event_type, occurred_at, snippet_text, subject, metadata_json, source_table, source_id")
        .eq("lead_id", lead_id)
        .eq("hidden", false)
        .order("occurred_at", { ascending: false })
        .limit(30),

      // Conversation analysis from all linked contacts
      admin.from("contacts")
        .select("id")
        .eq("lead_id", lead_id)
        .eq("workspace_id", workspaceId)
        .then(async ({ data: contacts }) => {
          if (!contacts || contacts.length === 0) return { data: [] };
          const contactIds = contacts.map((c: any) => c.id);
          return admin.from("conversation_analysis")
            .select("summary_text, summary_short, sentiment, urgency, topics, extracted_features, recommended_reply_channel, created_at")
            .in("contact_id", contactIds)
            .eq("workspace_id", workspaceId)
            .order("created_at", { ascending: false })
            .limit(10);
        }),

      // Call analyses from linked sessions
      admin.from("call_sessions")
        .select("id")
        .eq("lead_id", lead_id)
        .eq("workspace_id", workspaceId)
        .then(async ({ data: sessions }) => {
          if (!sessions || sessions.length === 0) return { data: [] };
          const sessionIds = sessions.map((s: any) => s.id);
          return admin.from("call_analyses")
            .select("summary_short, summary_long, signals_json, recommended_next_steps_json, status, created_at")
            .in("call_session_id", sessionIds)
            .eq("status", "completed")
            .order("created_at", { ascending: false })
            .limit(5);
        }),

      // Meeting summaries
      admin.from("meeting_summaries")
        .select("meeting_title, summary_text, participants_emails, sent_at")
        .eq("lead_id", lead_id)
        .order("sent_at", { ascending: false })
        .limit(5),
    ]);

    const timelineItems = timelineRes.data ?? [];
    const convoAnalyses = convoAnalysisRes.data ?? [];
    const callAnalyses = callAnalysisRes.data ?? [];
    const meetings = meetingRes.data ?? [];

    // ── 3. Aggregate across all sources ──

    // Collect all objections
    const allObjections = new Set<string>();
    const allBuyingSignals = new Set<string>();
    const allRisks: any[] = [];
    const allMilestones: any[] = [];
    const evidenceRefs: any[] = [];
    const channelActivity: Record<string, number> = {};

    // From conversation analyses
    for (const ca of convoAnalyses) {
      const features = (ca.extracted_features ?? {}) as Record<string, any>;
      if (Array.isArray(features.objections)) {
        features.objections.forEach((o: string) => allObjections.add(o));
      }
      if (Array.isArray(features.buying_signals)) {
        features.buying_signals.forEach((s: string) => allBuyingSignals.add(s));
      }
      if (Array.isArray(features.key_facts)) {
        features.key_facts.forEach((f: string) => {
          evidenceRefs.push({ source: "conversation_analysis", fact: f, timestamp: ca.created_at });
        });
      }
    }

    // From call analyses
    for (const ca of callAnalyses) {
      const signals = (ca.signals_json ?? {}) as Record<string, any>;
      if (Array.isArray(signals.objections)) {
        for (const obj of signals.objections) {
          allObjections.add(typeof obj === "string" ? obj : obj.type || JSON.stringify(obj));
        }
      }
      if (Array.isArray(signals.risks)) {
        for (const risk of signals.risks) {
          allRisks.push({
            issue: risk.type || risk.text || "Unknown risk",
            level: risk.severity || "medium",
            evidence: risk.evidence?.[0]?.quote || ca.summary_short || "",
            source: "call_analysis",
          });
        }
      }
      if (Array.isArray(signals.commitments)) {
        for (const c of signals.commitments) {
          allMilestones.push({
            description: c.text || "Commitment",
            status: c.dueDate && new Date(c.dueDate) < new Date() ? "completed" : "pending",
            date: c.dueDate || null,
            evidence: c.evidence?.[0]?.quote || "",
            source: "call_analysis",
          });
        }
      }
      if (Array.isArray(ca.recommended_next_steps_json)) {
        for (const step of ca.recommended_next_steps_json as any[]) {
          evidenceRefs.push({ source: "call_analysis", recommendation: step.text, confidence: step.confidence });
        }
      }
    }

    // From lead's existing milestones/risks (from prior deep analysis)
    const leadMilestones = Array.isArray(lead.milestones_json) ? (lead.milestones_json as any[]) : [];
    const leadRisks = Array.isArray(lead.risks_json) ? (lead.risks_json as any[]) : [];

    for (const m of leadMilestones) {
      if (!allMilestones.some((am: any) => am.description === m.description)) {
        allMilestones.push({ ...m, source: "lead_analysis" });
      }
    }
    for (const r of leadRisks) {
      if (!allRisks.some((ar: any) => ar.issue === r.issue)) {
        allRisks.push({ ...r, source: "lead_analysis" });
      }
    }

    // Channel activity counts
    for (const item of timelineItems) {
      channelActivity[item.channel] = (channelActivity[item.channel] || 0) + 1;
    }

    // Engagement signals
    const engagementSignals: Record<string, any> = {
      engagement_score: lead.engagement_score,
      channel_activity: channelActivity,
      total_timeline_events: timelineItems.length,
      latest_sentiment: convoAnalyses[0]?.sentiment || null,
      latest_urgency: convoAnalyses[0]?.urgency || null,
    };

    // Channel recommendation (from most recent conversation analysis)
    const channelRecs: Record<string, any> = {};
    if (convoAnalyses[0]?.recommended_reply_channel) {
      channelRecs.recommended_channel = convoAnalyses[0].recommended_reply_channel;
      const features = (convoAnalyses[0].extracted_features ?? {}) as Record<string, any>;
      channelRecs.channel_reason = features.channel_reason || null;
    }

    // ── 4. Build summary via LLM ──
    let summaryText = lead.next_step ? `Next: ${lead.next_step}` : null;
    let recommendedNextStep = lead.next_step || null;
    let nextStepReason = lead.next_step_reason || null;
    let modelUsed: string | null = null;

    if (lovableKey && (timelineItems.length > 0 || convoAnalyses.length > 0 || callAnalyses.length > 0)) {
      try {
        const timelineSummary = timelineItems.slice(0, 15).map(t =>
          `[${t.channel}/${t.direction || ""}] ${t.subject || ""}: ${(t.snippet_text || "").substring(0, 150)}`
        ).join("\n");

        const convoSummaries = convoAnalyses.slice(0, 3).map(ca =>
          `Conversation: ${ca.summary_short || ca.summary_text || "N/A"} (sentiment: ${ca.sentiment || "?"})`
        ).join("\n");

        const callSummaries = callAnalyses.slice(0, 2).map(ca =>
          `Call: ${ca.summary_short || "N/A"}`
        ).join("\n");

        const meetingSummaries = meetings.slice(0, 2).map(m =>
          `Meeting "${m.meeting_title || "Untitled"}": ${(m.summary_text || "").substring(0, 200)}`
        ).join("\n");

        const prompt = `You are a sales intelligence engine. Synthesize the following multi-channel evidence for a B2B lead and return JSON ONLY.

Lead: ${lead.name} at ${lead.company} | Stage: ${lead.stage} | Motion: ${lead.motion}

Timeline (recent):
${timelineSummary || "No timeline events"}

Conversation analyses:
${convoSummaries || "None"}

Call analyses:
${callSummaries || "None"}

Meetings:
${meetingSummaries || "None"}

Existing milestones: ${allMilestones.length}
Existing risks: ${allRisks.length}
Existing objections: ${allObjections.size}

Return:
{
  "summary": "2-3 sentence deal summary covering current state and momentum",
  "recommended_next_step": "specific actionable next step",
  "next_step_reason": "1 sentence why this step matters now"
}

Rules:
- Be specific to this lead, not generic
- Reference evidence from the data provided
- If insufficient data, say "Insufficient evidence" for summary
- Return valid JSON only, no markdown`;

        const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${lovableKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
          }),
        });

        if (aiRes.ok) {
          const aiData = await aiRes.json();
          const content = aiData.choices?.[0]?.message?.content ?? "";
          const cleaned = content.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
          try {
            const parsed = JSON.parse(cleaned);
            if (parsed.summary) summaryText = parsed.summary;
            if (parsed.recommended_next_step) recommendedNextStep = parsed.recommended_next_step;
            if (parsed.next_step_reason) nextStepReason = parsed.next_step_reason;
            modelUsed = "google/gemini-2.5-flash-lite";
          } catch { /* fallback to lead fields */ }
        } else {
          await aiRes.text(); // consume body
        }
      } catch (err) {
        console.error("[recompute-lead-intelligence] LLM error:", err);
      }
    }

    // ── 5. Upsert into lead_intelligence ──
    const intelligenceRow = {
      lead_id,
      workspace_id: workspaceId,
      summary_text: summaryText,
      recommended_next_step: recommendedNextStep,
      next_step_reason: nextStepReason,
      milestones_json: allMilestones,
      risks_json: allRisks,
      objections_json: [...allObjections],
      engagement_signals_json: engagementSignals,
      channel_recommendations_json: channelRecs,
      evidence_json: evidenceRefs.slice(0, 50),
      deal_factors_json: lead.deal_factors_json || {},
      last_computed_at: new Date().toISOString(),
      model_used: modelUsed,
      source_counts_json: {
        timeline_items: timelineItems.length,
        conversation_analyses: convoAnalyses.length,
        call_analyses: callAnalyses.length,
        meetings: meetings.length,
      },
    };

    const { error: upsertErr } = await admin
      .from("lead_intelligence")
      .upsert(intelligenceRow, { onConflict: "lead_id" });

    if (upsertErr) {
      console.error("[recompute-lead-intelligence] Upsert error:", upsertErr);
      return respond({ ok: false, error: "Failed to store intelligence" }, 500);
    }

    // ── 6. Mirror key fields to leads for backward compat ──
    await admin.from("leads").update({
      next_step: recommendedNextStep,
      next_step_reason: nextStepReason,
      milestones_json: allMilestones,
      risks_json: allRisks,
      last_ai_run_at: new Date().toISOString(),
    }).eq("id", lead_id);

    console.log(`[recompute-lead-intelligence] ✅ Lead ${lead_id}: ${timelineItems.length} timeline, ${convoAnalyses.length} convos, ${callAnalyses.length} calls, ${meetings.length} meetings`);

    return respond({
      ok: true,
      intelligence: intelligenceRow,
      source_counts: intelligenceRow.source_counts_json,
    });
  } catch (err) {
    console.error("[recompute-lead-intelligence] Error:", err);
    return respond({ ok: false, error: "Internal error" }, 500);
  }
});
