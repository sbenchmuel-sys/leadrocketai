// ============================================================
// eligibleAtFormat — timezone-aware formatters for `leads.eligible_at`
// (and any other timestamp the Queue UI surfaces to a user).
//
// `eligible_at` is persisted in UTC by `deriveAction` (see
// supabase/functions/_shared/syncEngine.ts). When the Queue UI
// renders it as "Eligible at 9:30 AM" or "Fires in 3h", the formatter
// MUST convert to workspace time (workspaces.timezone, IANA name)
// rather than defaulting to the browser's local TZ — otherwise reps
// in different TZs see the same lead with different "fires in" times,
// and reps on the same workspace machine still see a misleading hour
// if their browser's TZ != workspace.
//
// EDGE_CASES.md §11 and KNOWN_ISSUES.md track this. Today nothing in
// the UI renders `eligible_at`, so there's no current bug — this
// helper exists so PR D (Queue UI) has a single correct surface to
// reach for instead of inlining `toLocaleString()` per call site.
//
// Implementation note: we use the built-in `Intl.DateTimeFormat` with
// an explicit `timeZone` option (IANA names like "America/New_York").
// No `date-fns-tz` dependency — Intl supports this in every modern
// browser and is already what date-fns-tz uses under the hood.
// ============================================================

/** What we render when no timezone is configured. The workspace
 *  timezone column is required for automation sends (see
 *  20260430200000_workspace_timezone.sql — automation fails closed
 *  without it), but for read-only display we fall back to UTC so the
 *  string is still unambiguous rather than silently using browser TZ. */
const FALLBACK_TZ = "UTC";

/** Best-effort sanity check: is the string a usable IANA timezone?
 *  Intl.DateTimeFormat throws RangeError on garbage input; we'd
 *  rather catch that and fall back than blow up a render. */
function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function resolveTz(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? tz : FALLBACK_TZ;
}

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Absolute wall-clock rendering in workspace time.
 *  Examples: "Tue 9:30 AM", "9:30 AM" (same day), "Mar 12, 9:30 AM" (different month).
 *
 *  The "include weekday vs include date" decision is based on how
 *  far the target is from now (in workspace TZ). Within 24h → just
 *  time; within 7 days → weekday + time; otherwise → date + time. */
export function formatEligibleAtAbsolute(
  iso: string | null | undefined,
  workspaceTz: string | null | undefined,
  now: Date = new Date(),
): string {
  const d = parseIso(iso);
  if (!d) return "";
  const tz = resolveTz(workspaceTz);

  const deltaMs = d.getTime() - now.getTime();
  const absHours = Math.abs(deltaMs) / (60 * 60 * 1000);

  const baseOpts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  };

  if (absHours < 24) {
    return new Intl.DateTimeFormat("en-US", baseOpts).format(d);
  }
  if (absHours < 24 * 7) {
    return new Intl.DateTimeFormat("en-US", {
      ...baseOpts,
      weekday: "short",
    }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", {
    ...baseOpts,
    month: "short",
    day: "numeric",
  }).format(d);
}

/** Relative rendering. Examples: "Fires in 3h", "Fires in 2d", "Overdue 1h".
 *  Sign is independent of TZ (it's just a millisecond diff from now),
 *  so this function does NOT need a workspaceTz argument. */
export function formatEligibleAtRelative(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  const d = parseIso(iso);
  if (!d) return "";

  const deltaMs = d.getTime() - now.getTime();
  const overdue = deltaMs < 0;
  const absMs = Math.abs(deltaMs);
  const minutes = Math.floor(absMs / (60 * 1000));
  const hours = Math.floor(absMs / (60 * 60 * 1000));
  const days = Math.floor(absMs / (24 * 60 * 60 * 1000));

  const prefix = overdue ? "Overdue" : "Fires in";
  if (days >= 1) return `${prefix} ${days}d`;
  if (hours >= 1) return `${prefix} ${hours}h`;
  if (minutes >= 1) return `${prefix} ${minutes}m`;
  return overdue ? "Overdue" : "Fires now";
}

/** Combined "Eligible at <absolute> (<relative>)" helper for places
 *  that want both. Keeps the workspaceTz threading in one spot. */
export function formatEligibleAt(
  iso: string | null | undefined,
  workspaceTz: string | null | undefined,
  now: Date = new Date(),
): string {
  const d = parseIso(iso);
  if (!d) return "";
  const abs = formatEligibleAtAbsolute(iso, workspaceTz, now);
  const rel = formatEligibleAtRelative(iso, now);
  return `${abs} (${rel})`;
}
