// ============================================================
// postSendDeriveAction — shared post-send action recompute
//
// Today only gmail-sync and outlook-sync run `syncEngine.deriveAction`
// after activity, which means SMS / WhatsApp / voice sends leave
// `needs_action` stale on the lead until the next mail sync — and
// for leads that never get email activity, indefinitely.
//
// This helper consolidates the recompute so the three new send-path
// wirings (sms-send, whatsapp-send, twilio-voice-webhook) become a
// two-line call site each. Mirrors the bottom half of gmail-sync's
// per-lead recompute (metrics → derive → buildLeadUpdate → UPDATE).
//
// Reuse rules:
//   • Owns its own try/catch — a failure here MUST NOT fail the send.
//   • Background-task pattern (EdgeRuntime.waitUntil where available,
//     fire-and-forget otherwise) so the caller doesn't await.
//   • gmail-send is INTENTIONALLY not migrated to this helper in this
//     PR (see PR B brief). Its existing pattern stays untouched; this
//     helper exists so the three new wirings don't drift. Consolidating
//     gmail-send is a future cleanup.
//
// What this does NOT do (deliberate scope):
//   • Does not recompute meeting_packs follow-up state — gmail/outlook
//     sync owns that side effect. Helper just reads the meeting count.
//   • Does not call AI analysis paths — those stay in each send fn
//     where they already exist for channel-specific reasons.
//   • Does not touch interactions / timeline writes — the caller owns
//     those (and must have completed them BEFORE invoking the helper,
//     so the metrics computation here sees the just-sent outbound).
// ============================================================

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  buildLeadUpdate,
  computeMetricsFromInteractions,
  deepMergeCadence,
  DEFAULT_CADENCE_SETTINGS,
  deriveAction,
  deriveStage,
} from "./syncEngine.ts";

interface PostSendDeriveActionParams {
  leadId: string;
  /** Optional log prefix for traceability, e.g. "[sms-send]". */
  logPrefix?: string;
}

/**
 * Recompute `needs_action` / `next_action_*` / `eligible_at` for the
 * lead AFTER the caller has persisted its outbound interaction.
 *
 * Fire-and-forget: the caller does NOT need to await. All work runs
 * in a background task; errors are logged but never thrown.
 *
 * IMPORTANT: the caller must have already inserted the outbound
 * interaction (so `computeMetricsFromInteractions` sees fresh
 * `last_outbound_at`) before invoking this helper.
 */
export function postSendDeriveAction(
  supabase: SupabaseClient,
  params: PostSendDeriveActionParams,
): void {
  const prefix = params.logPrefix ?? "[postSendDeriveAction]";
  const task = async (): Promise<void> => {
    try {
      await runRecompute(supabase, params.leadId, prefix);
    } catch (err) {
      // This catch is the last line of defence. Anything that escapes
      // runRecompute lands here. Never throws.
      console.error(`${prefix} postSendDeriveAction failed:`, err instanceof Error ? err.message : err);
    }
  };

  const runtime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(task());
  } else {
    task().catch((err) => console.error(`${prefix} postSendDeriveAction outer:`, err));
  }
}

async function runRecompute(
  supabase: SupabaseClient,
  leadId: string,
  prefix: string,
): Promise<void> {
  // 1. Lead snapshot — strategy / motion / dismissal / meeting flag.
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select(
      "id, stage, strategy, owner_user_id, has_future_meeting, action_dismissed_at, motion, workspace_id",
    )
    .eq("id", leadId)
    .maybeSingle();

  if (leadErr || !lead) {
    console.warn(`${prefix} lead fetch failed for ${leadId}:`, leadErr?.message ?? "not found");
    return;
  }

  const currentStage = (lead as { stage?: string }).stage ?? "new";
  const strategy = ((lead as { strategy?: string }).strategy ?? "fast") as "fast" | "nurture";
  const ownerUserId = (lead as { owner_user_id?: string }).owner_user_id ?? null;
  const hasFutureMeeting = (lead as { has_future_meeting?: boolean }).has_future_meeting === true;
  const actionDismissedAt = (lead as { action_dismissed_at?: string | null }).action_dismissed_at ?? null;
  const leadMotion = (lead as { motion?: string }).motion ?? "outbound_prospecting";

  // 2. All interactions for metrics. The just-sent outbound MUST be
  // already persisted by the caller for this to be accurate.
  const { data: allInteractions, error: intErr } = await supabase
    .from("interactions")
    .select("type, direction, occurred_at, body_text")
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: true });

  if (intErr) {
    console.warn(`${prefix} interactions fetch failed for ${leadId}:`, intErr.message);
    return;
  }

  // 3. Meeting count — used by deriveStage + buildLeadUpdate. We do
  // NOT recompute hasMeetingWithoutFollowup here (see module comment).
  const { count: meetingCount } = await supabase
    .from("meeting_packs")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId);

  const { metrics, hasClosingKeywords } = computeMetricsFromInteractions(
    (allInteractions ?? []) as Array<{
      type: string;
      direction: string | null;
      occurred_at: string;
      body_text: string | null;
    }>,
    meetingCount ?? 0,
  );

  // 4. Workspace cadence / timezone for deriveAction guardrails.
  let cadenceSettings = DEFAULT_CADENCE_SETTINGS;
  let timezone: string | null = null;
  if (ownerUserId) {
    const { data: profile } = await supabase
      .from("workspace_profiles")
      .select("cadence_settings, meeting_timezone")
      .eq("user_id", ownerUserId)
      .maybeSingle();
    if (profile) {
      const p = profile as { cadence_settings?: object; meeting_timezone?: string | null };
      cadenceSettings = deepMergeCadence(DEFAULT_CADENCE_SETTINGS, p.cadence_settings ?? {});
      timezone = p.meeting_timezone ?? null;
    }
  }
  const modeSettings = cadenceSettings.modes[strategy] ?? cadenceSettings.modes.fast;

  // 5. Pending-draft nurture cadence (mirrors gmail-sync logic).
  const { data: pendingDrafts } = await supabase
    .from("drafts")
    .select("id, nurture_cadence")
    .eq("lead_id", leadId)
    .in("status", ["pending", "saved"]);
  const nurtureCadence =
    (pendingDrafts ?? []).find((d: { nurture_cadence?: string | null }) => d.nurture_cadence)?.nurture_cadence
    ?? (strategy === "nurture" ? "weekly" : null);

  // 6. Recent-outbound counts for the guardrail check.
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const recentOutbound7d = (allInteractions ?? []).filter((i: { direction: string | null; occurred_at: string }) =>
    i.direction === "outbound" && new Date(i.occurred_at).getTime() > now - 7 * DAY,
  ).length;
  const recentOutbound30d = (allInteractions ?? []).filter((i: { direction: string | null; occurred_at: string }) =>
    i.direction === "outbound" && new Date(i.occurred_at).getTime() > now - 30 * DAY,
  ).length;

  // 7. Derive stage + action.
  const stage = deriveStage(currentStage, metrics, hasClosingKeywords);
  const actionResult = deriveAction(
    leadId,
    metrics,
    nurtureCadence,
    stage,
    /* hasMeetingWithoutFollowup */ false,
    hasFutureMeeting,
    recentOutbound7d,
    recentOutbound30d,
    modeSettings,
    cadenceSettings.guardrails,
    cadenceSettings.stop_pause_rules,
    cadenceSettings.flows,
    timezone,
    strategy,
    leadMotion,
  );

  // 8. buildLeadUpdate needs the current consent / sequence state.
  const { data: currentLeadState } = await supabase
    .from("leads")
    .select("eligible_at, needs_action, motion, nurture_status, ooo_until, automation_mode")
    .eq("id", leadId)
    .maybeSingle();

  const leadUpdate = buildLeadUpdate(
    stage,
    metrics,
    actionResult,
    actionDismissedAt,
    currentLeadState
      ? {
          needs_action: (currentLeadState as { needs_action?: boolean }).needs_action ?? false,
          eligible_at: (currentLeadState as { eligible_at?: string | null }).eligible_at ?? null,
          motion: (currentLeadState as { motion?: string }).motion ?? leadMotion,
          nurture_status: (currentLeadState as { nurture_status?: string }).nurture_status ?? "",
          ooo_until: (currentLeadState as { ooo_until?: string | null }).ooo_until ?? null,
        }
      : null,
    (currentLeadState as { automation_mode?: string | null })?.automation_mode ?? null,
  );

  // 9. Persist.
  const { error: updErr } = await supabase
    .from("leads")
    .update(leadUpdate)
    .eq("id", leadId);

  if (updErr) {
    console.warn(`${prefix} lead update failed for ${leadId}:`, updErr.message);
    return;
  }

  console.log(`${prefix} recomputed needs_action=${leadUpdate.needs_action} stage=${stage} for ${leadId}`);
}
