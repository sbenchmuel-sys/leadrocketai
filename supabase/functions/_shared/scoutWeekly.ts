// ============================================================
// scoutWeekly — the pure decisions behind scout-weekly-run.
//
//   localClock / weekKey / weekStartIso   the workspace-tz clock + the
//                     Monday-start week a batch belongs to
//   isSlotReached     has this profile's delivery day/hour arrived this week
//   canAttempt        at most MAX_WEEKLY_ATTEMPTS failed tries per week
//   allocate          workspace scout_weekly_cap shared across reps
//   parseRankPicks    validate the AI ranking (ids, fit_label, anchors)
//
// delivery_dow (0=Sunday) / delivery_hour are stored in the WORKSPACE timezone
// (workspaces.timezone; Unit 2 shows them in the same tz). The week starts
// Monday 00:00 workspace time; a profile gets at most one batch per week,
// enforced by the unique (profile_id, slot_key) index on scout_runs.
// Pure: no Deno, no clients. Tested in scoutWeekly.test.ts.
// ============================================================

/** Same fallback pilot-reports uses when workspaces.timezone is NULL/invalid. */
export const DEFAULT_TZ = "America/New_York";
export const MAX_WEEKLY_ATTEMPTS = 3;
export const MAX_SEARCH_PAGES = 5;

export interface LocalClock {
  /** 0 = Sunday … 6 = Saturday, in the workspace tz. */
  dow: number;
  hour: number;
  minute: number;
  second: number;
  year: number;
  month: number;
  day: number;
  tz: string;
}

const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clockIn(now: Date, tz: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    dow: DOWS.indexOf(get("weekday")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    tz,
  };
}

/** The workspace-local clock. Unknown/invalid tz → DEFAULT_TZ. */
export function localClock(now: Date, tz: string | null | undefined): LocalClock {
  try {
    if (tz) return clockIn(now, tz);
  } catch { /* invalid IANA name */ }
  return clockIn(now, DEFAULT_TZ);
}

/** Days since Monday (Mon=0 … Sun=6). */
const sinceMonday = (dow: number) => (dow + 6) % 7;

/** "YYYY-MM-DD" of this week's Monday, workspace-local. The batch claim key. */
export function weekKey(c: LocalClock): string {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day - sinceMonday(c.dow)));
  return d.toISOString().slice(0, 10);
}

/**
 * Instant of this week's Monday 00:00 workspace-local.
 * ponytail: subtracts elapsed local time from `now`, so in a week with a DST
 * change it's off by the DST hour. Only used for the cap count; upgrade with a
 * tz library if a 1h edge on Monday midnight ever matters.
 */
export function weekStartIso(now: Date, c: LocalClock): string {
  const elapsedMs = (((sinceMonday(c.dow) * 24 + c.hour) * 60 + c.minute) * 60 + c.second) * 1000;
  return new Date(Math.floor(now.getTime() / 1000) * 1000 - elapsedMs).toISOString();
}

/** The profile's delivery day/hour has arrived in the current (Monday-start) week. */
export function isSlotReached(p: { delivery_dow: number; delivery_hour: number }, c: LocalClock): boolean {
  const today = sinceMonday(c.dow);
  const slotDay = sinceMonday(p.delivery_dow);
  return today > slotDay || (today === slotDay && c.hour >= p.delivery_hour);
}

/** Failed attempts this week release the claim; stop after MAX_WEEKLY_ATTEMPTS. */
export function canAttempt(failedThisWeek: number): boolean {
  return failedThisWeek < MAX_WEEKLY_ATTEMPTS;
}

/** Claim key a failed run is moved to, freeing `weekKey` for a retry next hour. */
export const failedSlotKey = (week: string, runId: string) => `${week}:failed:${runId}`;

/**
 * An unfinished claim older than this was abandoned (the process died between
 * claim and finish). ponytail: fixed 2h, far above the dispatcher's 55s budget;
 * if runs ever go async/long, store a heartbeat instead of trusting started_at.
 */
export const ABANDONED_CLAIM_MS = 2 * 60 * 60 * 1000;

/**
 * The week's claim row (slot_key = weekKey) → what the run should do:
 *   free       no claim yet — claim and run
 *   done       finished (delivered, empty, or cap reached) — nothing this week
 *   running    unfinished but recent — another invocation owns it
 *   abandoned  unfinished and stale — the caller counts its inserted
 *              candidates: any → treat as delivered; none → release as failed
 */
export function weekClaimState(
  claim: { started_at: string | null; finished_at: string | null } | undefined,
  now: Date,
): "free" | "done" | "running" | "abandoned" {
  if (!claim) return "free";
  if (claim.finished_at) return "done";
  const started = claim.started_at ? Date.parse(claim.started_at) : NaN;
  // Unknown start → treat as stale rather than blocking the profile all week.
  return now.getTime() - started < ABANDONED_CLAIM_MS ? "running" : "abandoned";
}

/**
 * How many leads this profile may get: min(weekly_target, cap − already created
 * this week across ALL reps in the workspace). Never negative.
 */
export function allocate(cap: number, createdThisWeek: number, weeklyTarget: number): number {
  return Math.max(0, Math.min(weeklyTarget, Math.max(0, cap) - Math.max(0, createdThisWeek)));
}

/** Stubs to collect before ranking: weekly_target×3, bounded by what we'll keep. */
export const searchGoal = (n: number) => n * 3;

export type FitLabel = "high" | "good";

export interface RankPick<T> {
  stub: T;
  reason: string;
  fit_label: FitLabel;
  anchor_lead_id: string | null;
}

const FALLBACK_REASON = "Matches the people and companies you're looking for.";

/**
 * AI `{ picks: [{ id, reason, fit_label, anchor_lead_id }] }` → up to `max`
 * validated picks. Unknown/duplicate ids dropped; fit_label forced to
 * high|good; anchor_lead_id kept only when it's one of `allowedAnchors` (the
 * rep's real leads). Returns null when the output is missing/malformed — the
 * caller fails closed (keywords/exclusions are enforced only by this step, so
 * an unranked fallback could spend credits on excluded people).
 */
export function parseRankPicks<T extends { provider_person_id: string }>(
  raw: unknown,
  stubs: T[],
  max: number,
  allowedAnchors: Iterable<string>,
): RankPick<T>[] | null {
  // deno-lint-ignore no-explicit-any
  const picks = (raw as any)?.picks;
  if (!Array.isArray(picks)) return null;
  const byId = new Map(stubs.map((s) => [s.provider_person_id, s]));
  const anchors = new Set(allowedAnchors);
  const used = new Set<string>();
  const out: RankPick<T>[] = [];
  for (const p of picks) {
    if (out.length >= max) break;
    // deno-lint-ignore no-explicit-any
    const o = (p && typeof p === "object" ? p : {}) as Record<string, any>;
    const id = typeof o.id === "string" ? o.id : null;
    const stub = id ? byId.get(id) : undefined;
    if (!stub || used.has(id!)) continue;
    used.add(id!);
    const reason = typeof o.reason === "string" ? o.reason.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    out.push({
      stub,
      reason: reason || FALLBACK_REASON,
      fit_label: o.fit_label === "high" ? "high" : "good",
      anchor_lead_id: typeof o.anchor_lead_id === "string" && anchors.has(o.anchor_lead_id) ? o.anchor_lead_id : null,
    });
  }
  return out;
}
