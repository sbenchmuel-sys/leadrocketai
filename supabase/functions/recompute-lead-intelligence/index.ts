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

// ── Evidence Registry ──────────────────────────────────────────
interface EvidenceRef {
  id: string;           // auto-generated ordinal key e.g. "ev-1"
  source_type: string;  // "timeline_item" | "conversation_analysis" | "call_analysis" | "meeting_summary"
  source_id: string;    // actual row ID from source table
  snippet: string;      // short human-readable excerpt
  channel?: string;
  occurred_at?: string;
}

let evidenceCounter = 0;
const evidenceRegistry: EvidenceRef[] = [];

function registerEvidence(
  sourceType: string,
  sourceId: string,
  snippet: string,
  channel?: string,
  occurredAt?: string,
): string {
  evidenceCounter++;
  const id = `ev-${evidenceCounter}`;
  evidenceRegistry.push({
    id,
    source_type: sourceType,
    source_id: sourceId,
    snippet: snippet.substring(0, 200),
    channel,
    occurred_at: occurredAt,
  });
  return id;
}

// ── Normalized types ───────────────────────────────────────────
interface NormalizedRisk {
  issue: string;
  level: "low" | "medium" | "high";
  evidence_ids: string[];
  source_types: string[];
}
interface NormalizedMilestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
  evidence_ids: string[];
  source_types: string[];
}
interface NormalizedObjection {
  text: string;
  evidence_ids: string[];
  source_types: string[];
}
interface NormalizedBuyingSignal {
  text: string;
  evidence_ids: string[];
  source_types: string[];
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

    // Reset evidence registry for this run
    evidenceCounter = 0;
    evidenceRegistry.length = 0;

    // ── 2. Parallel fetch all evidence sources ──
    const [timelineRes, convoAnalysisRes, callAnalysisRes, meetingRes, contextItemsRes] = await Promise.all([
      admin.from("lead_timeline_items")
        .select("id, channel, direction, event_type, occurred_at, snippet_text, subject, metadata_json, source_table, source_id")
        .eq("lead_id", lead_id)
        .eq("hidden", false)
        .order("occurred_at", { ascending: false })
        .limit(30),

      admin.from("contacts")
        .select("id")
        .eq("lead_id", lead_id)
        .eq("workspace_id", workspaceId)
        .then(async ({ data: contacts }) => {
          if (!contacts || contacts.length === 0) return { data: [] };
          const contactIds = contacts.map((c: any) => c.id);
          return admin.from("conversation_analysis")
            .select("id, summary_text, summary_short, sentiment, urgency, topics, extracted_features, recommended_reply_channel, created_at")
            .in("contact_id", contactIds)
            .eq("workspace_id", workspaceId)
            .order("created_at", { ascending: false })
            .limit(10);
        }),

      admin.from("call_sessions")
        .select("id")
        .eq("lead_id", lead_id)
        .eq("workspace_id", workspaceId)
        .then(async ({ data: sessions }) => {
          if (!sessions || sessions.length === 0) return { data: [] };
          const sessionIds = sessions.map((s: any) => s.id);
          return admin.from("call_analyses")
            .select("id, summary_short, summary_long, signals_json, recommended_next_steps_json, status, created_at, call_session_id")
            .in("call_session_id", sessionIds)
            .eq("status", "completed")
            .order("created_at", { ascending: false })
            .limit(5);
        }),

      admin.from("meeting_summaries")
        .select("id, meeting_title, summary_text, participants_emails, sent_at")
        .eq("lead_id", lead_id)
        .order("sent_at", { ascending: false })
        .limit(5),

      // Lead context items (imported data, manual notes, referrals, cautions)
      admin.from("lead_context_items")
        .select("id, category, content_type, content_text, original_snippet, source_type, source_column_name, confidence, author_name, context_date, is_active")
        .eq("lead_id", lead_id)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(30),
    ]);

    const timelineItems = timelineRes.data ?? [];
    const convoAnalyses = convoAnalysisRes.data ?? [];
    const callAnalyses = callAnalysisRes.data ?? [];
    const meetings = meetingRes.data ?? [];

    // ── 3. Build evidence-linked aggregation ──

    const risksMap = new Map<string, NormalizedRisk>();
    const milestonesMap = new Map<string, NormalizedMilestone>();
    const objectionsMap = new Map<string, NormalizedObjection>();
    const buyingSignalsMap = new Map<string, NormalizedBuyingSignal>();
    const channelActivity: Record<string, number> = {};
    const channelSentiment: Record<string, { positive: number; negative: number; neutral: number }> = {};
    const channelRecommendations: Record<string, number> = {}; // aggregate votes
    const nextStepEvidence: string[] = [];

    // Helper to add/merge into maps
    function addRisk(issue: string, level: string, evidenceId: string, sourceType: string) {
      const key = issue.toLowerCase().trim();
      const existing = risksMap.get(key);
      if (existing) {
        existing.evidence_ids.push(evidenceId);
        if (!existing.source_types.includes(sourceType)) existing.source_types.push(sourceType);
        // Escalate level
        const levels = ["low", "medium", "high"];
        if (levels.indexOf(level) > levels.indexOf(existing.level)) existing.level = level as any;
      } else {
        risksMap.set(key, { issue, level: (level || "medium") as any, evidence_ids: [evidenceId], source_types: [sourceType] });
      }
    }

    // Fuzzy similarity: word-overlap Jaccard > 0.6 means "same milestone"
    function findSimilarMilestoneKey(desc: string): string | null {
      const words = new Set(desc.toLowerCase().trim().replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 2));
      if (words.size === 0) return null;
      for (const [key, _] of milestonesMap) {
        const existingWords = new Set(key.replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 2));
        if (existingWords.size === 0) continue;
        const intersection = [...words].filter(w => existingWords.has(w)).length;
        const union = new Set([...words, ...existingWords]).size;
        if (union > 0 && intersection / union > 0.6) return key;
      }
      return null;
    }

    function addMilestone(desc: string, status: string, date: string | null, evidenceId: string, sourceType: string) {
      const key = desc.toLowerCase().trim();
      // Check exact match first, then fuzzy
      const matchKey = milestonesMap.has(key) ? key : findSimilarMilestoneKey(desc);
      if (matchKey) {
        const existing = milestonesMap.get(matchKey)!;
        existing.evidence_ids.push(evidenceId);
        if (!existing.source_types.includes(sourceType)) existing.source_types.push(sourceType);
      } else {
        milestonesMap.set(key, { description: desc, status: (status || "pending") as any, date, evidence_ids: [evidenceId], source_types: [sourceType] });
      }
    }

    function addObjection(text: string, evidenceId: string, sourceType: string) {
      const key = text.toLowerCase().trim();
      const existing = objectionsMap.get(key);
      if (existing) {
        existing.evidence_ids.push(evidenceId);
        if (!existing.source_types.includes(sourceType)) existing.source_types.push(sourceType);
      } else {
        objectionsMap.set(key, { text, evidence_ids: [evidenceId], source_types: [sourceType] });
      }
    }

    function addBuyingSignal(text: string, evidenceId: string, sourceType: string) {
      const key = text.toLowerCase().trim();
      const existing = buyingSignalsMap.get(key);
      if (existing) {
        existing.evidence_ids.push(evidenceId);
        if (!existing.source_types.includes(sourceType)) existing.source_types.push(sourceType);
      } else {
        buyingSignalsMap.set(key, { text, evidence_ids: [evidenceId], source_types: [sourceType] });
      }
    }

    // ── From ALL conversation analyses (not just latest) ──
    for (const ca of convoAnalyses) {
      const features = (ca.extracted_features ?? {}) as Record<string, any>;
      const evId = registerEvidence(
        "conversation_analysis", ca.id,
        ca.summary_short || ca.summary_text || "Conversation analysis",
        undefined, ca.created_at,
      );

      if (Array.isArray(features.objections)) {
        for (const o of features.objections) addObjection(typeof o === "string" ? o : String(o), evId, "conversation_analysis");
      }
      if (Array.isArray(features.buying_signals)) {
        for (const s of features.buying_signals) addBuyingSignal(typeof s === "string" ? s : String(s), evId, "conversation_analysis");
      }
      if (Array.isArray(features.key_facts)) {
        for (const f of features.key_facts) {
          registerEvidence("conversation_analysis", ca.id, typeof f === "string" ? f : String(f), undefined, ca.created_at);
        }
      }

      // Aggregate channel recommendations from ALL analyses
      if (ca.recommended_reply_channel) {
        channelRecommendations[ca.recommended_reply_channel] = (channelRecommendations[ca.recommended_reply_channel] || 0) + 1;
      }

      // Aggregate sentiment per analysis
      if (ca.sentiment) {
        const sentKey = ca.sentiment.toLowerCase();
        if (!channelSentiment["conversation"]) channelSentiment["conversation"] = { positive: 0, negative: 0, neutral: 0 };
        if (sentKey in channelSentiment["conversation"]) {
          (channelSentiment["conversation"] as any)[sentKey]++;
        }
      }
    }

    // ── From ALL call analyses ──
    for (const ca of callAnalyses) {
      const signals = (ca.signals_json ?? {}) as Record<string, any>;
      const evId = registerEvidence(
        "call_analysis", ca.id,
        ca.summary_short || "Call analysis",
        "voice", ca.created_at,
      );

      if (Array.isArray(signals.objections)) {
        for (const obj of signals.objections) {
          const text = typeof obj === "string" ? obj : obj.type || JSON.stringify(obj);
          addObjection(text, evId, "call_analysis");
        }
      }
      if (Array.isArray(signals.risks)) {
        for (const risk of signals.risks) {
          const riskEvId = registerEvidence(
            "call_analysis", ca.id,
            risk.evidence?.[0]?.quote || ca.summary_short || "Risk from call",
            "voice", ca.created_at,
          );
          addRisk(
            risk.type || risk.text || "Unknown risk",
            risk.severity || "medium",
            riskEvId, "call_analysis",
          );
        }
      }
      if (Array.isArray(signals.commitments)) {
        for (const c of signals.commitments) {
          const mEvId = registerEvidence(
            "call_analysis", ca.id,
            c.evidence?.[0]?.quote || c.text || "Commitment from call",
            "voice", ca.created_at,
          );
          addMilestone(
            c.text || "Commitment",
            c.dueDate && new Date(c.dueDate) < new Date() ? "completed" : "pending",
            c.dueDate || null,
            mEvId, "call_analysis",
          );
        }
      }
      if (Array.isArray(ca.recommended_next_steps_json)) {
        for (const step of ca.recommended_next_steps_json as any[]) {
          const nsEvId = registerEvidence("call_analysis", ca.id, step.text || "Next step from call", "voice", ca.created_at);
          nextStepEvidence.push(nsEvId);
        }
      }
    }

    // ── From meeting summaries ──
    for (const m of meetings) {
      registerEvidence(
        "meeting_summary", m.id,
        `Meeting "${m.meeting_title || "Untitled"}": ${(m.summary_text || "").substring(0, 150)}`,
        "meeting", m.sent_at,
      );
    }

    // ── From lead's existing milestones/risks ──
    const leadMilestones = Array.isArray(lead.milestones_json) ? (lead.milestones_json as any[]) : [];
    const leadRisks = Array.isArray(lead.risks_json) ? (lead.risks_json as any[]) : [];

    for (const m of leadMilestones) {
      if (m.description && !milestonesMap.has(m.description.toLowerCase().trim())) {
        const evId = registerEvidence("lead_analysis", lead.id, m.evidence || m.description, undefined);
        addMilestone(m.description, m.status || "pending", m.date || null, evId, "lead_analysis");
      }
    }
    for (const r of leadRisks) {
      if (r.issue && !risksMap.has(r.issue.toLowerCase().trim())) {
        const evId = registerEvidence("lead_analysis", lead.id, r.evidence || r.issue, undefined);
        addRisk(r.issue, r.level || "medium", evId, "lead_analysis");
      }
    }

    // ── Channel activity counts from timeline ──
    for (const item of timelineItems) {
      channelActivity[item.channel] = (channelActivity[item.channel] || 0) + 1;
      // Register timeline evidence
      registerEvidence("timeline_item", item.id, item.snippet_text || item.subject || item.event_type, item.channel, item.occurred_at);
    }

    // ── Engagement signals (normalized scores, not just counts) ──
    const totalEvents = timelineItems.length;
    const inboundCount = timelineItems.filter(t => t.direction === "inbound").length;
    const outboundCount = timelineItems.filter(t => t.direction === "outbound").length;
    const responseRate = outboundCount > 0 ? Math.round((inboundCount / outboundCount) * 100) : 0;

    // Sentiment aggregation across ALL analyses
    let positiveCount = 0, negativeCount = 0, neutralCount = 0;
    for (const ca of convoAnalyses) {
      const s = (ca.sentiment || "").toLowerCase();
      if (s === "positive") positiveCount++;
      else if (s === "negative") negativeCount++;
      else neutralCount++;
    }
    const totalSentiment = positiveCount + negativeCount + neutralCount;
    const sentimentScore = totalSentiment > 0
      ? Math.round(((positiveCount - negativeCount) / totalSentiment) * 100)
      : 0;

    // Urgency aggregation
    let highUrgency = 0, mediumUrgency = 0;
    for (const ca of convoAnalyses) {
      const u = (ca.urgency || "").toLowerCase();
      if (u === "high") highUrgency++;
      else if (u === "medium") mediumUrgency++;
    }

    const engagementSignals = {
      engagement_score: lead.engagement_score,
      total_timeline_events: totalEvents,
      inbound_count: inboundCount,
      outbound_count: outboundCount,
      response_rate_pct: responseRate,
      channel_activity: channelActivity,
      sentiment_score: sentimentScore,
      sentiment_breakdown: { positive: positiveCount, negative: negativeCount, neutral: neutralCount },
      urgency_breakdown: { high: highUrgency, medium: mediumUrgency },
    };

    // ── Channel recommendations (aggregated votes, not just latest) ──
    const topChannel = Object.entries(channelRecommendations)
      .sort(([, a], [, b]) => b - a)[0];

    const channelRecs = {
      recommended_channel: topChannel?.[0] || null,
      vote_counts: channelRecommendations,
      total_analyses: convoAnalyses.length,
    };

    // ── 4. Build summary via LLM ──
    let summaryText = lead.next_step ? `Next: ${lead.next_step}` : null;
    let recommendedNextStep = lead.next_step || null;
    let nextStepReason = lead.next_step_reason || null;
    let modelUsed: string | null = null;
    let nextStepEvidenceIds: string[] = [...nextStepEvidence];

    if (lovableKey && (timelineItems.length > 0 || convoAnalyses.length > 0 || callAnalyses.length > 0)) {
      try {
        const timelineSummary = timelineItems.slice(0, 15).map(t =>
          `[${t.channel}/${t.direction || ""}] ${t.subject || ""}: ${(t.snippet_text || "").substring(0, 150)}`
        ).join("\n");

        const convoSummaries = convoAnalyses.map(ca =>
          `Conversation (${ca.id}): ${ca.summary_short || ca.summary_text || "N/A"} (sentiment: ${ca.sentiment || "?"})`
        ).join("\n");

        const callSummaries = callAnalyses.map(ca =>
          `Call (${ca.id}): ${ca.summary_short || "N/A"}`
        ).join("\n");

        const meetingSummaries = meetings.map(m =>
          `Meeting "${m.meeting_title || "Untitled"}" (${m.id}): ${(m.summary_text || "").substring(0, 200)}`
        ).join("\n");

        const prompt = `You are a sales intelligence engine. Synthesize the following multi-channel evidence for a B2B lead and return JSON ONLY.

Lead: ${lead.name} at ${lead.company} | Stage: ${lead.stage} | Motion: ${lead.motion}

Timeline (recent ${timelineItems.length} events):
${timelineSummary || "No timeline events"}

Conversation analyses (${convoAnalyses.length} total):
${convoSummaries || "None"}

Call analyses (${callAnalyses.length} total):
${callSummaries || "None"}

Meetings (${meetings.length} total):
${meetingSummaries || "None"}

Existing aggregated risks: ${risksMap.size}
Existing aggregated milestones: ${milestonesMap.size}
Existing aggregated objections: ${objectionsMap.size}
Existing buying signals: ${buyingSignalsMap.size}

Return:
{
  "summary": "2-3 sentence deal summary covering current state and momentum across ALL channels",
  "recommended_next_step": "specific actionable next step",
  "next_step_reason": "1 sentence why this step matters now"
}

Rules:
- Be specific to this lead, not generic
- Synthesize across ALL conversation analyses, not just the most recent
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

    // ── 5. Reconcile with deal_memory handled objections ──
    // If deal_memory tracks objections as "handled", filter them from
    // the canonical set UNLESS the latest inbound clearly re-raised them.
    // Rule: a handled objection resurfaces only if it appears in a
    // conversation_analysis or call_analysis from the last 48 hours.
    const allRisks = [...risksMap.values()];
    const allMilestones = [...milestonesMap.values()];
    let allObjections = [...objectionsMap.values()];
    const allBuyingSignals = [...buyingSignalsMap.values()];

    try {
      const { data: memRow } = await admin
        .from("deal_memory")
        .select("handled_objections")
        .eq("lead_id", lead_id)
        .maybeSingle();

      if (memRow?.handled_objections && Array.isArray(memRow.handled_objections) && memRow.handled_objections.length > 0) {
        const handledSet = new Set((memRow.handled_objections as string[]).map(h => h.toLowerCase().trim()));
        const recentCutoff = Date.now() - 48 * 60 * 60 * 1000; // 48 hours

        // Build set of objection texts that appeared in recent evidence
        const recentlyReRaised = new Set<string>();
        for (const obj of allObjections) {
          const objKey = obj.text.toLowerCase().trim();
          if (!handledSet.has(objKey)) continue;
          // Check if any evidence is recent (within 48h)
          for (const evId of obj.evidence_ids) {
            const ev = evidenceRegistry.find(e => e.id === evId);
            if (ev?.occurred_at && new Date(ev.occurred_at).getTime() > recentCutoff) {
              recentlyReRaised.add(objKey);
              break;
            }
          }
        }

        const beforeCount = allObjections.length;
        allObjections = allObjections.filter(obj => {
          const key = obj.text.toLowerCase().trim();
          // Keep if: not handled, OR re-raised recently
          if (!handledSet.has(key)) return true;
          if (recentlyReRaised.has(key)) return true;
          return false;
        });
        const removed = beforeCount - allObjections.length;
        if (removed > 0) {
          console.log(`[recompute-lead-intelligence] Filtered ${removed} handled objection(s) via deal_memory reconciliation`);
        }
      }
    } catch (reconErr) {
      console.error("[recompute-lead-intelligence] deal_memory reconciliation failed (non-fatal):", reconErr);
    }

    const intelligenceRow = {
      lead_id,
      workspace_id: workspaceId,
      summary_text: summaryText,
      recommended_next_step: recommendedNextStep,
      next_step_reason: nextStepReason,
      milestones_json: allMilestones,
      risks_json: allRisks,
      objections_json: allObjections,
      buying_signals_json: allBuyingSignals,
      engagement_signals_json: engagementSignals,
      channel_recommendations_json: channelRecs,
      evidence_json: evidenceRegistry.slice(0, 100),
      deal_factors_json: {
        ...(lead.deal_factors_json || {}),
        next_step_evidence_ids: nextStepEvidenceIds,
      },
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

    console.log(`[recompute-lead-intelligence] ✅ Lead ${lead_id}: ${timelineItems.length} timeline, ${convoAnalyses.length} convos, ${callAnalyses.length} calls, ${meetings.length} meetings, ${evidenceRegistry.length} evidence refs`);

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
