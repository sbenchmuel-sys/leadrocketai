// ============================================================
// followupRule — "my unanswered message after N days" (Unit Q1)
//
// ONE rule, in one pure place:
//   • their unanswered message  → `reply_now`  (unchanged, syncEngine branch A)
//   • MY unanswered message after N days → `followup_due`, for EVERY lead,
//     whether or not they ever replied.
//
// Why this file exists at all: `syncEngine.ts` reads `Deno.env` (getCorsHeaders)
// so `src/test/sharedPurity.test.ts` forbids importing it from `src/`. Keeping
// the rule (and the key sets the UI has to agree with) in a PURE module means a
// vitest spec can exercise the real code path instead of a copy. syncEngine
// imports from here; nothing here imports runtime code back.
//
// The keys defined here are HUMAN PROMPTS, never automatic sends:
//   • `followup_due` / `rate_limited` are deliberately NOT in
//     OUTBOUND_SEND_KEYS, and
//   • `buildLeadUpdate` blanks `eligible_at` before persisting them, because
//     `automation-executor`'s candidate query is key-agnostic
//     (needs_action = true AND eligible_at <= now AND automation_mode IS NOT
//     NULL). A prompt key carrying a due `eligible_at` would become a send
//     trigger. This unit adds NO new automatic-send path.
// ============================================================

/**
 * Structurally a `syncEngine.ActionResult` (narrower: these two keys always
 * carry a label, a date and a reason code). Declared locally rather than
 * imported so this module stays free of syncEngine's Deno-typed surface — a
 * `import type` from there drags `Deno.env` into the browser tsc program.
 */
export interface FollowupAction {
  needs_action: true;
  next_action_key: string;
  next_action_label: string;
  eligible_at: string;
  action_reason_code: "FOLLOWUP_DUE" | "RATE_LIMITED";
}

export const FOLLOWUP_DUE_KEY = "followup_due";
export const RATE_LIMITED_KEY = "rate_limited";

/**
 * Keys the automation executor may treat as a scheduled outbound send.
 * Lives here (rather than inline in `buildLeadUpdate`) so tests and the
 * consent gate read the same set. `reply_now`, `followup_due` and
 * `rate_limited` are absent BY DESIGN — they are prompts for the rep.
 */
export const OUTBOUND_SEND_KEYS: ReadonlySet<string> = new Set([
  "send_pre_1", "send_pre_2", "send_pre_3", "send_pre_4",
  "send_nurture_1", "send_nurture_2", "send_nurture_3", "send_nurture_4",
  "send_nurture_5", "send_nurture_6", "send_nurture_7", "send_nurture_8",
  "reengage", "closing_followup", "post_meeting_followup",
  "switch_to_nurture", "generate_post_meeting_recap",
]);

/**
 * Queue prompts for the rep. They are NOT cadence positions and NOT sends, so
 * nothing may schedule from them: `syncEngine.buildLeadUpdate` blanks their
 * `eligible_at`, and `AutomationPreviewCard`'s Resume refuses to carry them
 * into an armed `eligible_at`.
 */
export const PROMPT_ONLY_KEYS: ReadonlySet<string> = new Set([
  FOLLOWUP_DUE_KEY,
  RATE_LIMITED_KEY,
]);

/**
 * Every `next_action_key` `syncEngine.deriveAction` can emit, plus
 * `ooo_return_followup` (written by `_shared/oooPauseActions.ts`).
 * `send_nurture_N` is variable-length, so the canonical prefix stands in.
 *
 * `src/test/followupRule.test.ts` pins this list against the literals in
 * syncEngine.ts: a new key cannot be added without landing here, and a key
 * here has to be registered in the Queue's urgency map, chip routing and
 * action-type map.
 */
export const QUEUE_ACTION_KEYS: readonly string[] = [
  "reply_now",
  "ooo_return_followup",
  "generate_post_meeting_recap",
  "closing_followup",
  "post_meeting_followup",
  "send_pre_2",
  "send_pre_3",
  "send_pre_4",
  "send_nurture_1",
  "reengage",
  "switch_to_nurture",
  FOLLOWUP_DUE_KEY,
  RATE_LIMITED_KEY,
];

/** Keys emitted with `needs_action = false` — they never reach the Queue. */
export const NON_QUEUE_ACTION_KEYS: readonly string[] = [
  "paused_meeting_scheduled",
  "wait_reply_threshold",
];

/** Calendar-day defaults, per the recorded decision: fast 3, nurture 5. */
export const DEFAULT_FOLLOWUP_WAIT_DAYS = { fast: 3, nurture: 5 } as const;

/**
 * How many calendar days to wait on my own unanswered message before the
 * Queue asks the rep to follow up. Workspace override lives in
 * `workspace_profiles.cadence_settings.modes.<fast|nurture>.followup_wait_days`
 * (deep-merged over DEFAULT_CADENCE_SETTINGS — no new column needed).
 */
export function followupWaitDays(
  strategy: string,
  modeSettings?: { followup_wait_days?: number | null } | null,
): number {
  const configured = modeSettings?.followup_wait_days;
  // Floor of one day: below that the rule would overlap the same-day / 16-hour
  // send guardrails, which are deliberately silent (a lead emailed minutes ago
  // is not work). A workspace asking for 0 gets 1.
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 1) {
    return Math.floor(configured);
  }
  return strategy === "nurture" ? DEFAULT_FOLLOWUP_WAIT_DAYS.nurture : DEFAULT_FOLLOWUP_WAIT_DAYS.fast;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The rule. Returns a `followup_due` action when MY last message is the last
 * message and it is at least `waitDays` CALENDAR days old (business days were
 * considered and rejected — recorded decision), otherwise null.
 *
 * Deliberately blind to `stage` / `motion` / whether the lead ever replied:
 * that blindness is the fix. syncEngine's older branch required
 * `!last_inbound_at`, so a lead who replied once and then went quiet had no
 * follow-up rule at all and only resurfaced after the 45-day re-engagement
 * window — the six-week hole this unit closes.
 */
export function deriveFollowupDue(
  metrics: { last_outbound_at: string | null; last_inbound_at: string | null },
  waitDays: number,
  now: number = Date.now(),
): FollowupAction | null {
  const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
  const inboundTime = metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0;
  if (!Number.isFinite(outboundTime) || outboundTime <= 0) return null;
  // Their message is newer than mine → this is a reply to answer, not a
  // follow-up to send. syncEngine's REPLY PENDING branch owns that case.
  if (inboundTime >= outboundTime) return null;

  const dueAt = outboundTime + waitDays * DAY_MS;
  if (now < dueAt) return null;

  return {
    needs_action: true,
    next_action_key: FOLLOWUP_DUE_KEY,
    next_action_label: `Follow up (no reply in ${waitDays} day${waitDays === 1 ? "" : "s"})`,
    // Honest "due since" stamp. buildLeadUpdate strips it before persisting —
    // see the NO-AUTO-SEND INVARIANT there.
    eligible_at: new Date(dueAt).toISOString(),
    action_reason_code: "FOLLOWUP_DUE",
  };
}

/** "Sep 12" in the workspace's timezone (UTC when unset or invalid). */
export function formatAvailableDate(atMs: number, timezone: string | null): string {
  const d = new Date(atMs);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone ?? "UTC",
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(d);
  }
}

/**
 * A VOLUME cap (max emails per lead per 7d / 30d) fired: the lead is out of
 * automated sends for days. It used to return a null key with
 * `needs_action = false` and vanish from the Queue with no reason and no date.
 *
 * Scope, deliberately narrow: only the multi-day volume caps land here. The
 * 16-hour-gap and same-day guardrails stay silent exactly as they always were
 * — they trip on every lead the rep just emailed, so surfacing them would have
 * bounced every sent email straight back into the Queue as a no-op card.
 *
 * Wording: the cap pauses the AUTOMATIC send. The rep can still write to this
 * lead right now (the card's own button does exactly that), so the label must
 * not read as "you may not act until <date>".
 *
 * The date is rendered in the WORKSPACE's timezone, the same contract
 * `src/lib/eligibleAtFormat.ts` documents (workspace clock, never the
 * browser's) — deriveAction receives that timezone from its callers.
 */
export function rateLimitedAction(availableAtMs: number, timezone: string | null): FollowupAction {
  return {
    needs_action: true,
    next_action_key: RATE_LIMITED_KEY,
    next_action_label: `Follow up anytime — auto-send paused until ${formatAvailableDate(availableAtMs, timezone)}`,
    eligible_at: new Date(availableAtMs).toISOString(),
    action_reason_code: "RATE_LIMITED",
  };
}
