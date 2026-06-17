// ============================================================================
// campaign-touch-scheduler — cold cadence brain (Outreach Unit C, PR 2)
//
// Cron-dispatched (X-Internal-Secret / service-role via requireScheduledCaller).
// Owns the MANUAL + REVIEW side of the cold cadence; AUTOMATIC email touches are
// owned by automation-executor (it queries due auto-email touches directly and
// sends them through the full guardrail chain) — the two never touch the same
// touch (they partition on channel + send-mode + gate), so there is no two-writer
// race and no double-send.
//
// Per due touch (the next-in-line one: step_number = enrollment.current_step_number + 1):
//   - Reply bridge: if the lead replied since starting, mark the enrollment
//     'replied' and stop cold processing — the reply surfaces in the normal Queue
//     (Follow up) via the existing pause-on-inbound path.
//   - Manual touch (call/SMS/WhatsApp/LinkedIn): auto-skip if past max-age or the
//     lead can't receive that channel (advance the cadence — never stall); else
//     surface it as a Queue card (status='queued').
//   - Email touch: if the campaign is AUTOMATIC and the workspace can auto-send
//     (gate on + timezone + postal address) → leave it for the executor. Otherwise
//     (review mode, or automatic-but-not-yet-sendable) → surface as an approve-card.
//
// Drains oldest-due first; bounded per run. Idempotent and side-effect-clean.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";
import { loadExecutionSettings, type ExecutionSettings } from "../_shared/executionSettings.ts";
import { advanceColdEnrollment, endColdEnrollment, repliedSinceEnrollment } from "../_shared/coldOutreach.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const BATCH = 200; // due touches considered per run

function canReceive(channel: string, lead: { phone: string | null; linkedin_url: string | null; whatsapp_number: string | null }): boolean {
  switch (channel) {
    case "voice":
    case "sms": return !!lead.phone;
    case "whatsapp": return !!(lead.whatsapp_number || lead.phone);
    case "linkedin": return !!lead.linkedin_url;
    case "email": return true;
    default: return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const now = new Date();
  const nowIso = now.toISOString();

  const counters = { queued: 0, auto_skipped: 0, replied: 0, left_for_executor: 0, skipped: 0 };

  // ACTIVE campaigns — used to CONSTRAIN the due-touch queries below. A paused/inactive
  // campaign's overdue 'scheduled' touches must stay scheduled (so they resume on
  // un-pause — we must NOT clear them) but must NOT occupy the capped batch, or with
  // more than BATCH of them at the front they'd permanently starve live work. Filtering
  // the candidate set — not mutating the rows — fixes that while keeping pause reversible.
  const { data: activeCamps, error: campErr } = await supabase
    .from("campaigns").select("id, workspace_id, send_mode").eq("status", "active");
  if (campErr) {
    return new Response(JSON.stringify({ ok: false, error: campErr.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const activeCampIds = (activeCamps || []).map((c: any) => c.id);

  // EXECUTOR-OWNED campaigns = active + send_mode='automatic' + workspace gate fully on
  // (cold_auto_send_enabled + timezone + postal). The automation-executor sends those
  // AUTOMATIC email touches directly; the scheduler only ever leaves them untouched.
  // So the scheduler must NOT pull their EMAIL touches into its capped batch — a backlog
  // of them at the front would starve the manual/review touches behind them. (Manual
  // touches of the same campaigns are still the scheduler's job, so we exclude only by
  // channel=email AND executor-owned.)
  const autoWsIds = [...new Set((activeCamps || []).filter((c: any) => c.send_mode === "automatic").map((c: any) => c.workspace_id))];
  let gatedWs = new Set<string>();
  if (autoWsIds.length > 0) {
    const [{ data: wsRows }, { data: autoRows }] = await Promise.all([
      supabase.from("workspaces").select("id, timezone, cold_outreach_postal_address").in("id", autoWsIds),
      supabase.from("workspace_automation_settings").select("workspace_id, cold_auto_send_enabled").in("workspace_id", autoWsIds),
    ]);
    const autoOn = new Set((autoRows || []).filter((r: any) => r.cold_auto_send_enabled).map((r: any) => r.workspace_id));
    gatedWs = new Set((wsRows || [])
      .filter((w: any) => w.timezone && String(w.cold_outreach_postal_address || "").trim() && autoOn.has(w.id))
      .map((w: any) => w.id));
  }
  const executorOwned = new Set((activeCamps || [])
    .filter((c: any) => c.send_mode === "automatic" && gatedWs.has(c.workspace_id))
    .map((c: any) => c.id));
  const schedulerEmailCampIds = activeCampIds.filter((id: string) => !executorOwned.has(id));

  // 1) Due touches, oldest first. Two queries so neither channel starves the other:
  //    (a) MANUAL touches across ALL active campaigns;
  //    (b) EMAIL touches only for scheduler-owned campaigns (review-mode or
  //        automatic-but-gate-off) — executor-owned email touches are excluded.
  const TOUCH_SEL = "id, enrollment_id, campaign_id, lead_id, step_number, channel, status, eligible_at, max_age_at";
  let touches: any[] = [];
  if (activeCampIds.length > 0) {
    const manualQ = supabase.from("campaign_touch").select(TOUCH_SEL)
      .eq("status", "scheduled").in("campaign_id", activeCampIds)
      .neq("channel", "email").lte("eligible_at", nowIso)
      .order("eligible_at", { ascending: true }).limit(BATCH);
    const emailQ = schedulerEmailCampIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabase.from("campaign_touch").select(TOUCH_SEL)
          .eq("status", "scheduled").in("campaign_id", schedulerEmailCampIds)
          .eq("channel", "email").lte("eligible_at", nowIso)
          .order("eligible_at", { ascending: true }).limit(BATCH);
    const [manualRes, emailRes] = await Promise.all([manualQ, emailQ]);
    if (manualRes.error || emailRes.error) {
      return new Response(JSON.stringify({ ok: false, error: (manualRes.error || emailRes.error)!.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    touches = [...(manualRes.data || []), ...(emailRes.data || [])];
  }
  // NOTE: do NOT early-return when there are no active campaigns / no due touches. BOTH
  // later passes must still run on every tick: (a) the stale-queued cleanup — an ignored
  // manual touch already in status='queued' wouldn't match the scheduled query, and an
  // early return would stall the cadence forever; and (b) the bounce-rate circuit
  // breaker — an over-threshold campaign must still auto-pause. With no due touches the
  // bulk loads run on empty id lists (harmless) and the processing loop is a no-op.

  // 2) Bulk-load the related rows into maps.
  const enrollmentIds = [...new Set(touches.map((t) => t.enrollment_id))];
  const campaignIds = [...new Set(touches.map((t) => t.campaign_id))];
  const leadIds = [...new Set(touches.map((t) => t.lead_id))];

  const [{ data: enrollments }, { data: campaigns }, { data: leads }] = await Promise.all([
    supabase.from("campaign_enrollment").select("id, status, current_step_number, started_at, enrolled_at").in("id", enrollmentIds),
    supabase.from("campaigns").select("id, status, send_mode, workspace_id").in("id", campaignIds),
    supabase.from("leads").select("id, owner_user_id, phone, linkedin_url, whatsapp_number, last_inbound_at, unsubscribed").in("id", leadIds),
  ]);
  const enrollmentMap = new Map((enrollments || []).map((e: any) => [e.id, e]));
  const campaignMap = new Map((campaigns || []).map((c: any) => [c.id, c]));
  const leadMap = new Map((leads || []).map((l: any) => [l.id, l]));

  const workspaceIds = [...new Set((campaigns || []).map((c: any) => c.workspace_id))];
  const [{ data: workspaces }, { data: autoSettings }] = await Promise.all([
    supabase.from("workspaces").select("id, timezone, cold_outreach_postal_address").in("id", workspaceIds),
    supabase.from("workspace_automation_settings").select("workspace_id, cold_auto_send_enabled").in("workspace_id", workspaceIds),
  ]);
  const workspaceMap = new Map((workspaces || []).map((w: any) => [w.id, w]));
  const autoSendMap = new Map((autoSettings || []).map((s: any) => [s.workspace_id, !!s.cold_auto_send_enabled]));

  // Per-owner execution settings (for advance/re-anchor), cached.
  const execCache = new Map<string, ExecutionSettings>();
  const getExec = async (ownerId: string): Promise<ExecutionSettings> => {
    if (!execCache.has(ownerId)) execCache.set(ownerId, await loadExecutionSettings(ownerId, supabase));
    return execCache.get(ownerId)!;
  };

  const markEnrollmentReplied = new Set<string>();

  // 3) Process each due touch.
  for (const t of touches) {
    const enr = enrollmentMap.get(t.enrollment_id);
    const camp = campaignMap.get(t.campaign_id);
    const lead = leadMap.get(t.lead_id);
    if (!enr || !camp || !lead) { counters.skipped++; continue; }

    // Only the next-in-line touch is ready; later pre-created touches wait.
    if (t.step_number !== (enr.current_step_number ?? 0) + 1) { counters.skipped++; continue; }
    // Enrollment / campaign must be live.
    if (!["scheduled", "active"].includes(enr.status)) { counters.skipped++; continue; }
    if (camp.status !== "active") { counters.skipped++; continue; }
    // Unsubscribed → STOP the enrollment AND clear its pending touches: leaving the
    // touch 'scheduled' would have it re-selected and skipped every run (oldest-first,
    // 200-row cap), eventually crowding out legitimate due work.
    if (lead.unsubscribed) {
      await endColdEnrollment(supabase, enr.id, "stopped");
      counters.skipped++;
      continue;
    }

    // Reply bridge: a reply since being committed to the cadence (enrolled_at, NOT the
    // possibly-future staggered started_at) pulls the lead out of the cold cadence and
    // clears its pending touches so they don't linger in the due queue.
    if (repliedSinceEnrollment(lead.last_inbound_at, enr.enrolled_at)) {
      if (!markEnrollmentReplied.has(t.enrollment_id)) {
        await endColdEnrollment(supabase, t.enrollment_id, "replied");
        markEnrollmentReplied.add(t.enrollment_id);
        counters.replied++;
      }
      continue;
    }

    const ws = workspaceMap.get(camp.workspace_id);
    const autoSendable =
      camp.send_mode === "automatic" &&
      autoSendMap.get(camp.workspace_id) === true &&
      !!ws?.timezone &&
      !!(ws?.cold_outreach_postal_address && String(ws.cold_outreach_postal_address).trim());

    // Re-read the touch FRESH before acting. A concurrent advanceColdEnrollment — the
    // executor sending the PRIOR touch, or another scheduler run — may have re-anchored
    // THIS touch's eligible_at/max_age_at into the future after this batch was selected,
    // while the freshly-loaded enrollment cursor now makes it pass the next-in-line
    // check above. Acting on the stale batch snapshot would queue or auto-skip it
    // prematurely, bypassing the cadence spacing. (The executor does the same re-check.)
    const { data: fresh } = await supabase
      .from("campaign_touch")
      .select("status, eligible_at, max_age_at")
      .eq("id", t.id)
      .maybeSingle();
    if (!fresh || fresh.status !== "scheduled") { counters.skipped++; continue; }
    if (fresh.eligible_at && new Date(fresh.eligible_at) > now) { counters.skipped++; continue; }
    const maxAgeAt = fresh.max_age_at; // use the fresh deadline for the auto-skip decision

    // ── Email touches ──
    if (t.channel === "email") {
      if (autoSendable) {
        // Owned by automation-executor — leave it untouched.
        counters.left_for_executor++;
        continue;
      }
      // Review mode (or automatic-but-not-sendable) → approve-card in Outreach.
      await supabase.from("campaign_touch").update({ status: "queued" }).eq("id", t.id);
      if (enr.status === "scheduled") await supabase.from("campaign_enrollment").update({ status: "active" }).eq("id", t.enrollment_id);
      counters.queued++;
      continue;
    }

    // ── Manual touches (call / SMS / WhatsApp / LinkedIn) ──
    const pastMaxAge = maxAgeAt && new Date(maxAgeAt) < now;
    const unreachable = !canReceive(t.channel, lead);
    if (pastMaxAge || unreachable) {
      const exec = await getExec(lead.owner_user_id);
      await advanceColdEnrollment(supabase, exec, t, "auto_skipped");
      counters.auto_skipped++;
      console.log(`[campaign-touch-scheduler] auto-skipped touch ${t.id} (${t.channel}) — ${pastMaxAge ? "past max-age" : "lead can't receive channel"}`);
      continue;
    }
    // Surface as a Queue card for the rep.
    await supabase.from("campaign_touch").update({ status: "queued" }).eq("id", t.id);
    if (enr.status === "scheduled") await supabase.from("campaign_enrollment").update({ status: "active" }).eq("id", t.enrollment_id);
    counters.queued++;
  }

  // 3b) Auto-skip STALE QUEUED manual touches. Once surfaced (status='queued') a
  // manual touch no longer matches the 'scheduled' due-query above, so its max_age_at
  // must be enforced HERE — otherwise an ignored call/SMS/WhatsApp/LinkedIn card
  // would block the cadence forever (current_step_number never advances). Only
  // manual touches carry max_age_at; review emails (max_age_at NULL) wait for the rep.
  // Also constrained to ACTIVE campaigns: a PAUSED campaign's queued touch must not be
  // auto-skipped (that would advance a paused cadence), and its dead rows must not
  // starve this capped batch either. They resume correctly when the campaign reactivates.
  const staleQueued = activeCampIds.length === 0 ? [] : (await supabase
    .from("campaign_touch")
    .select("id, enrollment_id, campaign_id, lead_id, step_number")
    .eq("status", "queued")
    .in("campaign_id", activeCampIds)
    .not("max_age_at", "is", null)
    .lt("max_age_at", nowIso)
    .limit(BATCH)).data;
  for (const t of (staleQueued || [])) {
    const { data: enr } = await supabase.from("campaign_enrollment")
      .select("current_step_number, status, started_at, enrolled_at").eq("id", t.enrollment_id).maybeSingle();
    if (!enr || !["scheduled", "active"].includes(enr.status)) continue;
    if (t.step_number !== (enr.current_step_number ?? 0) + 1) continue; // only the live touch
    const { data: ld } = await supabase.from("leads")
      .select("owner_user_id, last_inbound_at, unsubscribed").eq("id", t.lead_id).maybeSingle();
    if (!ld) continue;

    // REPLY BRIDGE for already-QUEUED manual touches. The main loop's reply bridge only
    // runs on 'scheduled' touches, so a reply that lands WHILE a manual card is queued
    // never reaches it. Without this check the max-age cleanup would auto-skip the card
    // and arm the next step — continuing the cold cadence AFTER an inbound reply. Pull
    // the lead out instead (and clear the stranded card).
    if (repliedSinceEnrollment(ld.last_inbound_at, enr.enrolled_at)) {
      await endColdEnrollment(supabase, t.enrollment_id, "replied");
      counters.replied++;
      continue;
    }
    // Unsubscribed (bounce / keyword / admin) → stop the enrollment, don't advance it.
    if (ld.unsubscribed) {
      await endColdEnrollment(supabase, t.enrollment_id, "stopped");
      continue;
    }

    const exec = await getExec(ld.owner_user_id);
    await advanceColdEnrollment(supabase, exec, t, "auto_skipped");
    counters.auto_skipped++;
    console.log(`[campaign-touch-scheduler] auto-skipped STALE queued touch ${t.id} (past max-age)`);
  }

  // ── Bounce-rate circuit breaker (Unit C, PR 4) ──────────────────────────────
  // Beyond the per-lead bounce stop (detectBounce → enrollment.bounced_at), track
  // each ACTIVE outreach's aggregate bounce rate; if too many addresses bounce,
  // auto-PAUSE the whole outreach (protects the rep's mailbox/domain reputation)
  // and log a volume_alert to cron_run_log (reusing the Unit 0 tripwire channel).
  // No new bounce list — counts come from the enrollment rows the sync handler
  // already stamps. Fully wrapped so it can never abort the run.
  try {
    // Validate env overrides before they gate a DESTRUCTIVE action (auto-pause). A
    // malformed BOUNCE_RATE_THRESHOLD → NaN → `rate < threshold` is always false →
    // EVERY campaign at min-volume gets auto-paused; a malformed BOUNCE_MIN_VOLUME
    // removes the early-noise guard. Use Number() (NOT parseFloat/parseInt, which
    // silently accept a numeric prefix — "1oops" → 1, "0.01oops" → 0.01) so any value
    // that isn't FULLY numeric falls back to the safe default, and clamp the threshold
    // to a sane (0,1].
    const numEnv = (key: string): number => {
      const raw = Deno.env.get(key);
      return raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    };
    const thresholdRaw = numEnv("BOUNCE_RATE_THRESHOLD");
    const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 1 ? thresholdRaw : 0.08; // 8%
    const minVolumeRaw = numEnv("BOUNCE_MIN_VOLUME");
    // Floor FIRST, then require >= 1. A fractional value like 0.5 passes `> 0` but
    // floors to 0, which makes `denom < minVolume` never true and lets a 0/0 = NaN
    // rate through (NaN < threshold is false), pausing campaigns with zero sends.
    const minVolumeFloored = Math.floor(minVolumeRaw);
    const minVolume = Number.isFinite(minVolumeRaw) && minVolumeFloored >= 1 ? minVolumeFloored : 20; // avoid early noise
    // Page through ALL active campaigns (ordered + stable), not just one capped,
    // unordered subset — otherwise, with more than a page of active outreaches, an
    // over-threshold campaign outside the subset could be evaluated on no tick.
    //
    // KEYSET (id-cursor) pagination, NOT offset .range(): this loop PAUSES campaigns
    // as it goes, which removes them from the status='active' filter. An offset
    // window (.range(200,399)) would then shift — every campaign paused on an earlier
    // page slides a later, still-active campaign backward past the window boundary,
    // so it is skipped entirely. Advancing a cursor by last-seen id is immune: paused
    // rows simply fall out behind the cursor and the next page resumes from id > last.
    const PAGE = 200;
    // Minimum uuid sentinel — id is a uuid column, so the cursor must be a valid
    // uuid (an empty string would fail the uuid cast in the gt filter).
    let lastId = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const { data: activeCampaigns } = await supabase
        .from("campaigns").select("id, name, workspace_id").eq("status", "active")
        .gt("id", lastId).order("id", { ascending: true }).limit(PAGE);
      if (!activeCampaigns || activeCampaigns.length === 0) break;
      lastId = activeCampaigns[activeCampaigns.length - 1].id;

      for (const c of activeCampaigns) {
        // Denominator: enrolled leads that have had ≥1 touch completed. Numerator: bounced.
        const [{ count: started }, { count: bounced }] = await Promise.all([
          supabase.from("campaign_enrollment").select("id", { count: "exact", head: true })
            .eq("campaign_id", c.id).gte("current_step_number", 1),
          supabase.from("campaign_enrollment").select("id", { count: "exact", head: true })
            .eq("campaign_id", c.id).not("bounced_at", "is", null),
        ]);
        const denom = started ?? 0;
        const numer = bounced ?? 0;
        if (denom < minVolume) continue;
        const rate = numer / denom;
        if (rate < threshold) continue;

        // Pause (guard on status='active' so we don't fight a concurrent change).
        const { data: paused } = await supabase.from("campaigns")
          .update({ status: "paused" }).eq("id", c.id).eq("status", "active").select("id");
        if ((paused || []).length === 0) continue; // someone else already changed it
        const pct = Math.round(rate * 100);
        await supabase.from("cron_run_log").insert({
          job_name: "campaign-touch-scheduler",
          dispatcher_target: "bounce_circuit_breaker",
          request_id: crypto.randomUUID(),
          started_at: new Date().toISOString(),
          status: "volume_alert",
          error_message: `Outreach ${c.id} (${c.name}) auto-paused: bounce rate ${pct}% (${numer}/${denom}) >= ${Math.round(threshold * 100)}%`,
        }).then(({ error }) => { if (error) console.warn("[campaign-touch-scheduler] alert log failed:", error.message); });
        console.warn(`[campaign-touch-scheduler] bounce breaker paused campaign ${c.id}: ${pct}% (${numer}/${denom})`);
      }

      if (activeCampaigns.length < PAGE) break;
    }
  } catch (breakerErr) {
    console.error("[campaign-touch-scheduler] bounce breaker error:", breakerErr);
  }

  console.log(`[campaign-touch-scheduler]`, JSON.stringify(counters));
  return new Response(JSON.stringify({ ok: true, ...counters }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
