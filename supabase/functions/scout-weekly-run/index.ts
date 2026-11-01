// scout-weekly-run — Lead Scout's weekly batch (hourly cron via cron-dispatcher).
//
// Each run: enabled workspaces (workspace_automation_settings.scout_enabled) →
// their status='active' scout profiles whose delivery day/hour has arrived in
// the WORKSPACE timezone (workspaces.timezone, the tz Unit 2 shows) and that
// have no batch yet this workspace-local week. Per profile:
//   1. claim the week: INSERT the kind='weekly' scout_runs row (unique
//      (profile_id, slot_key)) BEFORE searching — a second overlapping run gets
//      a unique violation and skips. Its id is the batch id.
//   2. N = min(weekly_target, workspace scout_weekly_cap − scout candidates
//      already created this week across ALL reps).
//   3. re-clamp profile_json (the browser wrote it), page Apollo People Search
//      (free) until N×3 kept stubs or 5 pages, EU/UK/EEA excluded unless allowed,
//      pre-enrichment scoutFilters.
//   4. ai_task scout_rank_batch → reason + fit_label + anchor_lead_id (anchors
//      validated against the rep's own leads); keep the top N.
//   5. INSERT lead_candidates (source 'ai_scout', status 'pending', owner = the
//      profile owner); an existing scout row for the person is skipped.
//   6. profile.auto_approve → hand the batch to scout-enrich (service role).
// Also returns scout rows stuck mid-enrichment (claimed > 30 min, no lead) to pending.
// Fail closed per profile: one bad profile never blocks the others. A failed
// attempt with nothing inserted releases the week's claim (max 3 tries/week).
// Nothing here emails, texts or enrolls anyone.
// No APOLLO_API_KEY → "scout: no provider key, skipping" (200).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";
import { apolloSearchPeople, type ProspectStub } from "../_shared/prospectProviders.ts";
import { EU_UK_EEA_COUNTRIES, filterScoutCandidates } from "../_shared/scoutFilters.ts";
import { type AdminClient, callScoutAi, loadPreFilterContext } from "../_shared/scoutGate.ts";
import { clampProfile, toApolloFilters } from "../_shared/scoutProfile.ts";
import {
  allocate, canAttempt, failedSlotKey, isSlotReached, localClock, MAX_SEARCH_PAGES, parseRankPicks,
  searchGoal, weekKey, weekStartIso,
} from "../_shared/scoutWeekly.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ponytail: bounded work per invocation so we stay inside the dispatcher's 55s
// budget; profiles not reached stay due and are picked up next hour.
const MAX_PROFILES_PER_RUN = 4;
const PER_PAGE = 25;
const STALE_CLAIM_MS = 30 * 60 * 1000;

interface Settings {
  workspace_id: string;
  scout_weekly_cap: number;
  scout_allow_eu: boolean;
}
interface Profile {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  profile_json: unknown;
  weekly_target: number;
  delivery_dow: number;
  delivery_hour: number;
  auto_approve: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const auth = requireScheduledCaller(req, cors);
  if (auth instanceof Response) return auth;

  const apiKey = Deno.env.get("APOLLO_API_KEY");
  if (!apiKey) {
    console.log("scout: no provider key, skipping");
    return json({ ok: true, skipped: "no_provider_key" });
  }
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin: AdminClient = createClient(url, serviceKey);
  const now = new Date();

  // Missing column (DB without the Scout migrations) or any error = off.
  const { data: settings, error: sErr } = await admin
    .from("workspace_automation_settings")
    .select("workspace_id, scout_weekly_cap, scout_allow_eu")
    .eq("scout_enabled", true);
  if (sErr || !settings?.length) return json({ ok: true, workspaces: 0 });
  const enabled = new Map((settings as Settings[]).map((s) => [s.workspace_id, s]));
  const wsIds = [...enabled.keys()];

  // An enrichment that died mid-way (function timeout) leaves rows claimed
  // ('approved') with no lead. Hand them back to the rep after 30 minutes.
  await admin.from("lead_candidates")
    .update({ status: "pending", resolved_at: null })
    .in("workspace_id", wsIds).eq("source", "ai_scout").eq("status", "approved")
    .is("resolved_lead_id", null).is("dismiss_reason", null)
    .lt("resolved_at", new Date(now.getTime() - STALE_CLAIM_MS).toISOString());

  const [{ data: profiles, error: pErr }, { data: workspaces }] = await Promise.all([
    admin.from("scout_profiles")
      .select("id, workspace_id, owner_user_id, profile_json, weekly_target, delivery_dow, delivery_hour, auto_approve")
      .eq("status", "active").in("workspace_id", wsIds).order("created_at", { ascending: true }),
    admin.from("workspaces").select("id, timezone").in("id", wsIds),
  ]);
  if (pErr) {
    console.error("[scout-weekly-run] profiles load failed", pErr.message);
    return json({ ok: false }, 500);
  }
  const tzOf = new Map(((workspaces ?? []) as Array<{ id: string; timezone: string | null }>).map((w) => [w.id, w.timezone]));

  const results: Record<string, unknown>[] = [];
  let attempted = 0;
  for (const p of (profiles ?? []) as Profile[]) {
    if (attempted >= MAX_PROFILES_PER_RUN) break;
    const clock = localClock(now, tzOf.get(p.workspace_id));
    if (!isSlotReached(p, clock)) continue;
    try {
      const r = await runProfile(admin, p, enabled.get(p.workspace_id)!, apiKey, now, clock);
      if (r.attempted) attempted++;
      results.push({ profile_id: p.id, ...r });
    } catch (e) {
      attempted++;
      console.error(`[scout-weekly-run] profile ${p.id} failed:`, e instanceof Error ? e.message : e);
      results.push({ profile_id: p.id, error: "failed" });
    }
  }
  return json({ ok: true, results });
});

async function runProfile(
  admin: AdminClient,
  p: Profile,
  s: Settings,
  apiKey: string,
  now: Date,
  clock: ReturnType<typeof localClock>,
): Promise<Record<string, unknown> & { attempted: boolean }> {
  const week = weekKey(clock);
  const { data: prior, error: priorErr } = await admin
    .from("scout_runs").select("slot_key")
    .eq("profile_id", p.id).eq("kind", "weekly").like("slot_key", `${week}%`);
  if (priorErr) throw new Error(`prior runs: ${priorErr.message}`);
  const keys = ((prior ?? []) as Array<{ slot_key: string }>).map((r) => r.slot_key);
  if (keys.includes(week)) return { attempted: false, skipped: "done_this_week" };
  if (!canAttempt(keys.filter((k) => k.startsWith(`${week}:failed:`)).length)) {
    return { attempted: false, skipped: "attempts_exhausted" };
  }

  // 1. Claim the week before any search.
  const { data: run, error: claimErr } = await admin
    .from("scout_runs")
    .insert({ workspace_id: p.workspace_id, profile_id: p.id, kind: "weekly", slot_key: week })
    .select("id").single();
  if (claimErr?.code === "23505") return { attempted: false, skipped: "claimed_elsewhere" };
  if (claimErr || !run?.id) throw new Error(`claim: ${claimErr?.message ?? "no row"}`);
  const batchId: string = run.id;
  const finish = (patch: Record<string, unknown>) =>
    admin.from("scout_runs").update({ finished_at: new Date().toISOString(), ...patch }).eq("id", batchId);

  let inserted = 0;
  let found = 0;
  try {
    // 2. Workspace cap across all reps.
    const { count, error: cErr } = await admin
      .from("lead_candidates").select("id", { count: "exact", head: true })
      .eq("workspace_id", p.workspace_id).eq("source", "ai_scout")
      .gte("created_at", weekStartIso(now, clock));
    if (cErr) throw new Error(`cap count: ${cErr.message}`);
    const n = allocate(s.scout_weekly_cap, count ?? 0, p.weekly_target);
    if (n === 0) {
      await finish({ error: "cap_reached" }); // the week's cap is spent: keep the claim
      return { attempted: true, kept: 0, reason: "cap_reached" };
    }

    // 3. Re-clamp, verify anchors are the rep's real leads, search + pre-filter.
    // deno-lint-ignore no-explicit-any
    const rawAnchors = (p.profile_json as any)?.anchor_lead_ids;
    const profile = clampProfile(p.profile_json, Array.isArray(rawAnchors) ? rawAnchors.filter((x) => typeof x === "string") : []);
    const { data: anchorRows } = profile.anchor_lead_ids.length
      ? await admin.from("leads").select("id, name, company, job_title")
        .in("id", profile.anchor_lead_ids).eq("workspace_id", p.workspace_id).eq("owner_user_id", p.owner_user_id)
      : { data: [] };
    const anchors = (anchorRows ?? []) as Array<{ id: string; name: string; company: string; job_title: string | null }>;

    const filters = toApolloFilters(profile, s.scout_allow_eu ? [] : EU_UK_EEA_COUNTRIES, PER_PAGE);
    const raw: ProspectStub[] = [];
    let kept: ProspectStub[] = [];
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const res = await apolloSearchPeople({ fetch, apiKey }, filters, page);
      if (res.error) {
        if (raw.length === 0) throw new Error(res.error);
        break; // keep what earlier pages found
      }
      found += res.data.length;
      raw.push(...res.data);
      kept = filterScoutCandidates(raw, await loadPreFilterContext(admin, p.workspace_id, s.scout_allow_eu, raw)).kept;
      if (kept.length >= searchGoal(n) || res.data.length < PER_PAGE) break;
    }
    const pool = kept.slice(0, searchGoal(n));
    if (pool.length === 0) {
      await finish({ candidates_found: found, candidates_kept: 0 });
      return { attempted: true, kept: 0 };
    }

    // 4. AI ranks; output validated, anchors limited to the rep's leads.
    const ai = await callScoutAi("scout_rank_batch", {
      profile,
      max: n,
      anchors: anchors.map((a) => ({ id: a.id, name: a.name, company: a.company, title: a.job_title })),
      candidates: pool.map((c) => ({
        id: c.provider_person_id, first_name: c.first_name, title: c.title,
        company: c.company_name, company_size: c.company_size, location: c.location,
      })),
    });
    const picks = parseRankPicks(ai, pool, n, anchors.map((a) => a.id));
    if (picks === null) throw new Error("ai rank failed");

    // 5. Insert. A person who already has a scout row (unique index) is skipped.
    const rows = picks.map(({ stub, reason, fit_label, anchor_lead_id }) => ({
      workspace_id: p.workspace_id,
      owner_user_id: p.owner_user_id,
      source: "ai_scout",
      status: "pending",
      contact_email: null,
      contact_name: stub.name ?? stub.first_name,
      company_domain: stub.company_domain,
      company_name: stub.company_name,
      company_size: stub.company_size,
      job_title: stub.title,
      linkedin_url: stub.linkedin_url,
      location: stub.location,
      ai_reason: reason,
      fit_label,
      anchor_lead_id,
      provider: stub.provider,
      provider_person_id: stub.provider_person_id,
      scout_batch_id: batchId,
    }));
    const ids: string[] = [];
    const bulk = rows.length ? await admin.from("lead_candidates").insert(rows).select("id") : { data: [], error: null };
    if (!bulk.error) {
      ids.push(...((bulk.data ?? []) as Array<{ id: string }>).map((r) => r.id));
    } else if (bulk.error.code === "23505") {
      // ponytail: the partial unique index can't be an ON CONFLICT target through
      // PostgREST, so on a clash fall back to row-by-row and skip duplicates.
      for (const row of rows) {
        const one = await admin.from("lead_candidates").insert(row).select("id").single();
        if (one.data?.id) ids.push(one.data.id);
        else if (one.error && one.error.code !== "23505") throw new Error(`insert: ${one.error.message}`);
      }
    } else {
      throw new Error(`insert: ${bulk.error.message}`);
    }
    inserted = ids.length;
    await finish({ candidates_found: found, candidates_kept: inserted });

    // 6. Auto-approve: enrichment runs as its own invocation (it can take minutes).
    if (p.auto_approve && ids.length) autoApprove(p.workspace_id, ids);
    return { attempted: true, kept: inserted, batch_id: batchId };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : "failed").slice(0, 300);
    // Nothing delivered → free the week's key so a later hour can retry (≤3/week).
    await finish({
      error: msg,
      candidates_found: found,
      candidates_kept: inserted,
      ...(inserted === 0 ? { slot_key: failedSlotKey(week, batchId) } : {}),
    });
    throw e;
  }
}

function autoApprove(workspaceId: string, candidateIds: string[]) {
  const task = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/scout-enrich`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      "X-Internal-Secret": Deno.env.get("INTERNAL_API_SECRET") ?? "",
    },
    body: JSON.stringify({ workspace_id: workspaceId, candidate_ids: candidateIds }),
  }).then(async (r) => {
    if (!r.ok) console.error("[scout-weekly-run] auto-approve failed", r.status, (await r.text()).slice(0, 200));
    else await r.body?.cancel();
  }).catch((e) => console.error("[scout-weekly-run] auto-approve error", e instanceof Error ? e.message : e));
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}
