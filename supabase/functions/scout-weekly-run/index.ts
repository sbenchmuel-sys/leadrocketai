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
//   3. re-clamp profile_json (the browser wrote it), learning step (last 4
//      weeks of dismiss reasons + replies/meetings → ai_task scout_learn, bounded
//      by applyLearning; fails open to the unchanged profile; the adjusted
//      profile is used for THIS batch only and its note lands on
//      scout_runs.learned_note), page Apollo People Search
//      (free) until N×3 kept stubs or 5 pages, EU/UK/EEA excluded unless allowed,
//      pre-enrichment scoutFilters.
//   4. ai_task scout_rank_batch → reason + fit_label + anchor_lead_id (anchors
//      validated against the rep's own leads); keep the top N.
//   5. INSERT lead_candidates (source 'ai_scout', status 'pending', owner = the
//      profile owner); an existing scout row for the person is skipped.
//   6. profile.auto_approve → hand the batch to scout-enrich (service role).
// Also returns scout rows stuck mid-enrichment (claimed > 30 min, no lead) to pending.
// Fail closed per profile: one bad profile never blocks the others. A failed
// attempt with nothing inserted releases the week's claim (max 3 tries/week);
// a claim left unfinished > 2h (process died) is recovered the same way.
// Nothing here emails, texts or enrolls anyone.
// No APOLLO_API_KEY → "scout: no provider key, skipping" (200).
// SCOUT_MONTHLY_CREDIT_CEILING reached → no provider calls + a volume_alert.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";
import { apolloSearchPeople, type ProspectStub } from "../_shared/prospectProviders.ts";
import { EU_UK_EEA_COUNTRIES, filterScoutCandidates } from "../_shared/scoutFilters.ts";
import { type AdminClient, callScoutAi, loadPreFilterContext, scoutCreditCeilingHit } from "../_shared/scoutGate.ts";
import { countResolvedBatches } from "../_shared/scoutEnrich.ts";
import { clampProfile, type ScoutProfile, toApolloFilters } from "../_shared/scoutProfile.ts";
import {
  allocate, applyLearning, buildLearningInput, canAttempt, LEARN_WINDOW_DAYS, type LearnCandidate, failedSlotKey, isSlotReached, localClock, MAX_SEARCH_PAGES, parseRankPicks,
  searchGoal, weekClaimState, weekKey, weekStartIso,
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

  // A batch whose last card was dismissed by hand never passes through
  // scout-enrich, so count finished batches here too (exactly-once per batch).
  // ponytail: newest 50 unresolved batches per hour; a very old batch the rep
  // never finishes can be starved, which only delays the auto-approve offer.
  const { data: openBatches } = await admin.from("scout_runs").select("id, workspace_id")
    .in("workspace_id", wsIds).eq("kind", "weekly").is("resolved_at", null).gt("candidates_kept", 0)
    .order("started_at", { ascending: false }).limit(50);
  for (const b of (openBatches ?? []) as Array<{ id: string; workspace_id: string }>) {
    await countResolvedBatches(admin, b.workspace_id, [b.id]);
  }

  // Monthly credit ceiling (all workspaces): no provider calls at all this run.
  if (await scoutCreditCeilingHit(admin, "scout-weekly-run")) return json({ ok: true, skipped: "credit_ceiling" });

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
    .from("scout_runs").select("id, slot_key, started_at, finished_at")
    .eq("profile_id", p.id).eq("kind", "weekly").like("slot_key", `${week}%`);
  if (priorErr) throw new Error(`prior runs: ${priorErr.message}`);
  const priorRows = (prior ?? []) as Array<{ id: string; slot_key: string; started_at: string; finished_at: string | null }>;
  const keys = priorRows.map((r) => r.slot_key);
  const claim = priorRows.find((r) => r.slot_key === week);
  const state = weekClaimState(claim, now);
  if (state === "done") return { attempted: false, skipped: "done_this_week" };
  if (state === "running") return { attempted: false, skipped: "claimed_elsewhere" };
  if (claim && state === "abandoned") {
    // The process died after claiming. Candidates already inserted = delivered.
    // ponytail: such a batch skips auto-approve; the rep reviews it by hand.
    const { count, error: kErr } = await admin.from("lead_candidates").select("id", { count: "exact", head: true })
      .eq("scout_batch_id", claim.id).eq("workspace_id", p.workspace_id);
    if (kErr) throw new Error(`abandoned claim count: ${kErr.message}`);
    // Conditional on still-unfinished week key: only one concurrent invocation wins.
    const { data: won, error: rErr } = await admin.from("scout_runs")
      .update({
        finished_at: new Date().toISOString(),
        error: "abandoned",
        ...(count ? { candidates_kept: count } : { slot_key: failedSlotKey(week, claim.id) }),
      })
      .eq("id", claim.id).eq("slot_key", week).is("finished_at", null).select("id");
    if (rErr) throw new Error(`abandoned claim release: ${rErr.message}`);
    if (count || !won?.length) return { attempted: false, skipped: count ? "done_this_week" : "claimed_elsewhere" };
    keys.push(failedSlotKey(week, claim.id));
  }
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

  let found = 0;
  let learnedNote = "";
  const ids: string[] = []; // outside try: a mid-insert failure must not release the claim
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
    let profile = clampProfile(p.profile_json, Array.isArray(rawAnchors) ? rawAnchors.filter((x) => typeof x === "string") : []);
    const { data: anchorRows } = profile.anchor_lead_ids.length
      ? await admin.from("leads").select("id, name, company, job_title")
        .in("id", profile.anchor_lead_ids).eq("workspace_id", p.workspace_id).eq("owner_user_id", p.owner_user_id)
      : { data: [] };
    const anchors = (anchorRows ?? []) as Array<{ id: string; name: string; company: string; job_title: string | null }>;

    const learned = await learnFromHistory(admin, p, profile, now);
    if (learned.note) learnedNote = learned.note;
    profile = learned.profile;

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
    await finish({ candidates_found: found, candidates_kept: ids.length });
    // Separate write so a DB without the learned_note column still finishes the batch.
    if (learnedNote) await admin.from("scout_runs").update({ learned_note: learnedNote }).eq("id", batchId);

    // 6. Auto-approve: enrichment runs as its own invocation (it can take minutes).
    if (p.auto_approve && ids.length) autoApprove(p.workspace_id, ids);
    return { attempted: true, kept: ids.length, batch_id: batchId };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : "failed").slice(0, 300);
    // Nothing delivered → free the week's key so a later hour can retry (≤3/week).
    await finish({
      error: msg,
      candidates_found: found,
      candidates_kept: ids.length,
      ...(ids.length === 0 ? { slot_key: failedSlotKey(week, batchId) } : {}),
    });
    throw e;
  }
}

/**
 * The learning step. Any failure → the unchanged profile (never blocks the batch).
 * ponytail: the adjusted profile is used for this week's search only; the rep's
 * saved profile (and sentence) never drift. Upgrade: persist + regenerate the
 * sentence once reps can see/undo what was learned.
 */
async function learnFromHistory(
  admin: AdminClient,
  p: Profile,
  base: ScoutProfile,
  now: Date,
): Promise<{ profile: ScoutProfile; note: string }> {
  const unchanged = { profile: base, note: "" };
  try {
    const since = new Date(now.getTime() - LEARN_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: runs, error: rErr } = await admin.from("scout_runs").select("id")
      .eq("profile_id", p.id).eq("kind", "weekly").gte("started_at", since).limit(10);
    if (rErr || !runs?.length) return unchanged;
    const { data: rows, error: cErr } = await admin.from("lead_candidates")
      .select("status, dismiss_reason, job_title, company_size, location, resolved_lead_id")
      .eq("workspace_id", p.workspace_id).eq("source", "ai_scout").neq("status", "pending")
      .in("scout_batch_id", (runs as Array<{ id: string }>).map((r) => r.id)).limit(500);
    if (cErr || !rows?.length) return unchanged;
    const cands = rows as LearnCandidate[];
    const leadIds = [...new Set(cands.map((c) => c.resolved_lead_id).filter((x): x is string => !!x))];
    let replied: string[] = [];
    let met: string[] = [];
    if (leadIds.length) {
      // Replies + meetings from the canonical ledger (never the legacy interactions table).
      const [tl, ld] = await Promise.all([
        admin.from("lead_timeline_items").select("lead_id, direction, event_type")
          .eq("workspace_id", p.workspace_id).in("lead_id", leadIds)
          .or("direction.eq.inbound,event_type.eq.meeting").limit(1000),
        admin.from("leads").select("id").eq("workspace_id", p.workspace_id).in("id", leadIds)
          .or("has_future_meeting.eq.true,stage.eq.closed_won"),
      ]);
      const items = (tl.data ?? []) as Array<{ lead_id: string; direction: string | null; event_type: string | null }>;
      replied = items.filter((t) => t.direction === "inbound").map((t) => t.lead_id);
      met = [...items.filter((t) => t.event_type === "meeting").map((t) => t.lead_id), ...((ld.data ?? []) as Array<{ id: string }>).map((l) => l.id)];
    }
    const input = buildLearningInput(cands, replied, met);
    if (!input) return unchanged;
    return applyLearning(base, await callScoutAi("scout_learn", { profile: base, ...input }));
  } catch (e) {
    console.warn(`[scout-weekly-run] learning skipped for ${p.id}:`, e instanceof Error ? e.message : e);
    return unchanged;
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
