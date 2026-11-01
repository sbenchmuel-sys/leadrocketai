// scout-build-profile — Lead Scout setup, step 1: "Here's who I think buys from you."
//
// Reads the rep's best leads (won, future meeting, or any inbound reply in
// lead_timeline_items — never the legacy interactions table) plus a short
// company-knowledge summary, and asks ai_task (scout_build_profile) for a
// target profile. Fewer than 5 good leads and no answers yet → needs_input
// with two questions; the panel re-calls with { answers: { who, where } }.
// Also makes sure the rep has a scout_profiles row (a 'draft' unless they pass
// their existing profile_id) — scout-sample's rate limit hangs off it.
// No-op unless workspace_automation_settings.scout_enabled.
import { anchorNames, callScoutAi, openScoutRequest, ownedProfileId, scoutJson, type ScoutRequest } from "../_shared/scoutGate.ts";
import { clampProfile, isEmptyProfile, needsInput, NEEDS_INPUT_QUESTIONS, profileSentence } from "../_shared/scoutProfile.ts";

const LEAD_COLS = "id, name, company, job_title, industry, city, state, country, stage, has_future_meeting";
type LeadRow = Record<string, unknown> & { id: string };

async function ensureProfileRow(r: ScoutRequest): Promise<string | null> {
  if (r.body.profile_id !== undefined) return ownedProfileId(r, r.body.profile_id);
  const { data: draft } = await r.admin
    .from("scout_profiles").select("id")
    .eq("workspace_id", r.workspaceId).eq("owner_user_id", r.userId).eq("status", "draft")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (draft?.id) return draft.id;
  const { data: created, error } = await r.admin
    .from("scout_profiles").insert({ workspace_id: r.workspaceId, owner_user_id: r.userId, status: "draft" })
    .select("id").single();
  if (error) console.error("[scout-build-profile] draft insert failed:", error.message);
  return created?.id ?? null;
}

/** Won / meeting first, then leads that replied. Owner's own leads only. */
async function bestLeads(r: ScoutRequest): Promise<LeadRow[]> {
  const { data: strong } = await r.admin
    .from("leads").select(LEAD_COLS)
    .eq("workspace_id", r.workspaceId).eq("owner_user_id", r.userId)
    .or("stage.eq.closed_won,has_future_meeting.eq.true")
    .order("last_activity_at", { ascending: false }).limit(30);

  const { data: inbound } = await r.admin
    .from("lead_timeline_items").select("lead_id")
    .eq("workspace_id", r.workspaceId).eq("direction", "inbound")
    .order("occurred_at", { ascending: false }).limit(500);
  const repliedIds = [...new Set((inbound ?? []).map((t: { lead_id: string }) => t.lead_id))].slice(0, 200);
  const { data: replied } = repliedIds.length
    ? await r.admin
      .from("leads").select(LEAD_COLS)
      .in("id", repliedIds).eq("workspace_id", r.workspaceId).eq("owner_user_id", r.userId).eq("unsubscribed", false)
      .limit(30)
    : { data: [] };

  const byId = new Map<string, LeadRow>();
  for (const l of [...(strong ?? []), ...(replied ?? [])] as LeadRow[]) if (!byId.has(l.id)) byId.set(l.id, l);
  return [...byId.values()].slice(0, 30);
}

/** Short company-knowledge summary: workspace profile + a few KB chunks (no vector search needed here). */
async function kbSummary(r: ScoutRequest): Promise<string> {
  const { data: wp } = await r.admin
    .from("workspace_profiles")
    .select("company_name, product_name, product_description, industry, primary_value_props, supported_use_cases")
    .eq("user_id", r.userId).maybeSingle();
  const { data: chunks } = await r.admin
    .from("kb_chunks").select("content")
    .eq("owner_user_id", r.userId).eq("processing_status", "completed")
    .order("created_at", { ascending: false }).limit(8);
  return [wp ? JSON.stringify(wp) : "", ...(chunks ?? []).map((c: { content: string }) => c.content)]
    .filter(Boolean).join("\n---\n").slice(0, 4000);
}

const answer = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 300) : "");

Deno.serve(async (req) => {
  const r = await openScoutRequest(req);
  if (r instanceof Response) return r;
  try {
    const profileId = await ensureProfileRow(r);
    if (!profileId) return scoutJson({ ok: false, error: "Profile not found" }, 404);

    // deno-lint-ignore no-explicit-any
    const a = (r.body.answers ?? {}) as any;
    const answers = { who: answer(a.who), where: answer(a.where) };
    const hasAnswers = !!(answers.who || answers.where);

    const leads = await bestLeads(r);
    if (needsInput(leads.length, hasAnswers)) {
      return scoutJson({ ok: true, needs_input: true, questions: NEEDS_INPUT_QUESTIONS, profile_id: profileId });
    }

    const result = await callScoutAi("scout_build_profile", {
      best_leads: leads.map((l) => ({
        ...l,
        why: l.stage === "closed_won" ? "won" : l.has_future_meeting ? "meeting booked" : "replied",
      })),
      company_knowledge: await kbSummary(r),
      ...(hasAnswers ? { answers } : {}),
    });
    const profile = clampProfile(result, leads.map((l) => l.id));
    if (!result || isEmptyProfile(profile)) return scoutJson({ ok: false, reason: "ai_failed", profile_id: profileId });

    const names = await anchorNames(r, profile.anchor_lead_ids);
    return scoutJson({
      ok: true,
      profile_id: profileId,
      profile,
      profile_sentence: profileSentence(profile, names),
      anchor_names: names,
    });
  } catch (e) {
    console.error("[scout-build-profile] error:", e instanceof Error ? e.message : e);
    return scoutJson({ ok: false, error: "Internal error" }, 500);
  }
});
