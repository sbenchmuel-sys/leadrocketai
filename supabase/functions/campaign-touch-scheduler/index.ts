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
import { advanceColdEnrollment, endColdEnrollment } from "../_shared/coldOutreach.ts";

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

  // 1) Due touches, oldest first.
  const { data: dueTouches, error: dueErr } = await supabase
    .from("campaign_touch")
    .select("id, enrollment_id, campaign_id, lead_id, step_number, channel, status, eligible_at, max_age_at")
    .eq("status", "scheduled")
    .lte("eligible_at", nowIso)
    .order("eligible_at", { ascending: true })
    .limit(BATCH);
  if (dueErr) {
    return new Response(JSON.stringify({ ok: false, error: dueErr.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // NOTE: do NOT early-return when no scheduled touches are due. The stale-queued
  // cleanup pass below must still run — if the only blocked work is an ignored
  // manual touch already in status='queued', the scheduled query is empty and an
  // early return would leave that touch (and the whole cadence) stalled forever.
  // With no due touches the bulk loads run on empty id lists (harmless) and the
  // processing loop is a no-op, so flow reaches the stale-queued cleanup.
  const touches = dueTouches || [];

  // 2) Bulk-load the related rows into maps.
  const enrollmentIds = [...new Set(touches.map((t) => t.enrollment_id))];
  const campaignIds = [...new Set(touches.map((t) => t.campaign_id))];
  const leadIds = [...new Set(touches.map((t) => t.lead_id))];

  const [{ data: enrollments }, { data: campaigns }, { data: leads }] = await Promise.all([
    supabase.from("campaign_enrollment").select("id, status, current_step_number, started_at").in("id", enrollmentIds),
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

    // Reply bridge: a reply since starting pulls the lead out of the cold cadence
    // (and clears its pending touches so they don't linger in the due queue).
    if (lead.last_inbound_at && enr.started_at && new Date(lead.last_inbound_at) > new Date(enr.started_at)) {
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
  const { data: staleQueued } = await supabase
    .from("campaign_touch")
    .select("id, enrollment_id, campaign_id, lead_id, step_number")
    .eq("status", "queued")
    .not("max_age_at", "is", null)
    .lt("max_age_at", nowIso)
    .limit(BATCH);
  for (const t of (staleQueued || [])) {
    const { data: enr } = await supabase.from("campaign_enrollment")
      .select("current_step_number, status, started_at").eq("id", t.enrollment_id).maybeSingle();
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
    if (ld.last_inbound_at && enr.started_at && new Date(ld.last_inbound_at) > new Date(enr.started_at)) {
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

  console.log(`[campaign-touch-scheduler]`, JSON.stringify(counters));
  return new Response(JSON.stringify({ ok: true, ...counters }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
