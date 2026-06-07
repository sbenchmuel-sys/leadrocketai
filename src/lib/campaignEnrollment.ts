// ============================================================================
// CAMPAIGN ENROLLMENT + DRIP PACING (Outreach Unit C, PR 1)
//
// Enrolls cold leads into a campaign and lays down their per-touch cadence in
// campaign_enrollment + campaign_touch. The cadence is ALWAYS relative to each
// lead's OWN start day — never a shared calendar.
//
// Throughput rules (these are load-bearing — see the build brief):
//  - Only AUTO-EMAIL touches consume the per-mailbox daily cap. Calls / SMS /
//    WhatsApp / LinkedIn are manual and do NOT — so pacing is computed from the
//    real email-touch count, not a fixed number.
//  - Staggered starts: we do NOT set every lead's first touch to "now". Starts
//    are dripped so projected daily email load (new starts + their future email
//    follow-ups) stays within the cap. Priority: a started lead's follow-ups are
//    booked first (never made late); only the START of not-yet-started leads waits.
//  - Business-day aware: the schedule advances in business days, so "day 2" never
//    lands on a weekend. (Send-window / recipient-timezone snapping to the local
//    morning happens at hand-off time in the scheduler/executor — PR 2/PR 4.)
//
// This module does NOT send anything and does NOT set leads.automation_mode /
// needs_action / eligible_at — so an enrolled lead is invisible to the existing
// automation-executor candidate query (the consent gate fail-closes). Sending is
// wired in PR 2 (scheduler + executor cold branch).
//
// The new tables are not in the generated types.ts until Lovable applies the
// migration, so writes cast `as any` (mirrors campaignQueries.ts).
// ============================================================================

import { supabase } from "@/integrations/supabase/client";
import type { CanonicalChannel } from "@/lib/channels";

// A touch's auto-skip horizon for MANUAL touches when the campaign has no later
// touch to bound it (a stuck manual touch must never stall the cadence forever).
const DEFAULT_MAX_AGE_BUSINESS_DAYS = 5;

// Default per-mailbox daily auto-email cap when settings can't be read. Matches
// DEFAULT_EXECUTION_SETTINGS.guardrails.max_sends_per_day_per_mailbox.
export const DEFAULT_DAILY_CAP = 40;

// Capacity-preview warning: if everyone can't be started within this many
// business days, the list is bigger than the mailbox can comfortably keep on
// schedule — warn the rep (and the scheduler ties this to the volume tripwire).
const CAPACITY_WARN_BUSINESS_DAYS = 20;

// ── Business-day helpers (client-side; server uses _shared/executionSettings) ─

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6; // Sun / Sat
}

/** The given date if it's a business day, else the next business day. */
export function nextBusinessDay(date: Date): Date {
  const d = new Date(date);
  while (isWeekend(d)) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Advance `n` business days from `date`. n=0 snaps to the next business day.
 * Weekends are skipped, so the result is always a business day.
 */
export function addBusinessDays(date: Date, n: number): Date {
  let d = nextBusinessDay(date);
  let remaining = Math.max(0, Math.floor(n));
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) remaining--;
  }
  return d;
}

/**
 * Business-day index of `date` relative to `anchor`, in the SAME space as
 * computeStaggeredStarts (0 = the anchor's business day). Past/overdue dates map
 * to 0. Used to seed the start planner with already-scheduled touch load.
 */
export function businessDayOffset(anchor: Date, date: Date): number {
  const start = nextBusinessDay(anchor);
  if (date <= start) return 0;
  let offset = 0;
  let cur = start;
  while (cur < date && offset < 1000) {
    cur = addBusinessDays(cur, 1);
    offset++;
  }
  return offset;
}

// ── Cadence shape ────────────────────────────────────────────────────────────

export interface CadenceStep {
  step_number: number;
  channel: CanonicalChannel | "linkedin";
  // Business-day gap AFTER the previous touch. Touch 1 is gap 0 (day 0).
  delay_days: number;
}

/**
 * Cumulative business-day offset of each step from the lead's start day.
 * offset[0] = 0 (touch 1 lands on the start day). Because each delay_days is a
 * business-day gap, the cumulative offset is just the running sum.
 */
export function cumulativeBusinessOffsets(steps: CadenceStep[]): number[] {
  let running = 0;
  return steps.map((s, i) => {
    running += i === 0 ? 0 : s.delay_days;
    return running;
  });
}

/** Business-day offsets of just the EMAIL touches (the only ones that consume the cap). */
export function emailOffsets(steps: CadenceStep[]): number[] {
  const offsets = cumulativeBusinessOffsets(steps);
  return steps
    .map((s, i) => ({ channel: s.channel, offset: offsets[i] }))
    .filter((x) => x.channel === "email")
    .map((x) => x.offset);
}

// ── Staggered starts (the drip) ───────────────────────────────────────────────

/**
 * Assign each lead a START offset (in business days from the anchor) so the
 * projected daily EMAIL load never exceeds `dailyCap`. Already-"started" leads'
 * email follow-ups are booked into the load first (so they're never bumped);
 * only the start of a not-yet-started lead waits for a day with room across ALL
 * of its email offsets.
 *
 * Returns an array of length `leadCount`: starts[i] = business-day index for lead i.
 * Pure + deterministic → unit-testable.
 */
export function computeStaggeredStarts(
  leadCount: number,
  emailTouchOffsets: number[],
  dailyCap: number,
  initialLoad?: Record<number, number>,
): number[] {
  if (leadCount <= 0) return [];
  // No email touches → nothing consumes the cap; everyone can start on day 0.
  // (initialLoad is about email-day pressure, irrelevant when this cadence has none.)
  if (emailTouchOffsets.length === 0) return new Array(leadCount).fill(0);

  const cap = Math.max(1, Math.floor(dailyCap)); // guard: cap < 1 would never start
  // Seed with already-booked load (existing scheduled email touches) so new starts
  // are placed AROUND days that are already at/near the cap.
  const load: Record<number, number> = { ...(initialLoad || {}) }; // business-day index → booked email touches
  const starts: number[] = [];
  let assigned = 0;
  let day = 0;
  // Generous upper bound on iterations: even at 1 start/day this terminates. It
  // MUST extend past the seeded load's furthest day — otherwise, when existing
  // touches already fill the cap through several future days, the loop could
  // exhaust its iterations and the fallback would park new starts on a day still
  // at capacity (the exact running-outreach case this seeding protects).
  const seededMax = Object.keys(load).reduce((m, k) => Math.max(m, Number(k)), 0);
  const maxDays =
    leadCount + emailTouchOffsets[emailTouchOffsets.length - 1] + leadCount * emailTouchOffsets.length + seededMax;

  while (assigned < leadCount && day <= maxDays) {
    // How many leads can START today? A start books +1 on day+offset for every
    // email offset, so room is the tightest headroom across all those days.
    let room = leadCount - assigned;
    for (const o of emailTouchOffsets) {
      room = Math.min(room, cap - (load[day + o] ?? 0));
    }
    room = Math.max(0, room);
    for (let i = 0; i < room; i++) {
      starts.push(day);
      for (const o of emailTouchOffsets) load[day + o] = (load[day + o] ?? 0) + 1;
    }
    assigned += room;
    day++;
  }
  // Fallback (should not happen): park any unassigned at the last considered day.
  while (starts.length < leadCount) starts.push(day);
  return starts;
}

// ── Capacity preview (honest plan shown at enrollment) ────────────────────────

export interface CapacityPlan {
  leadCount: number;
  emailTouchesPerLead: number;
  dailyCap: number;
  startsPerDay: number;
  daysToStartEveryone: number;
  emailsPerDayAtSteadyState: number;
  overCapacity: boolean;
  summary: string; // plain-language line for the rep
  warning: string | null;
}

/**
 * The honest "here's the plan" preview. Uses the steady-state approximation
 * startsPerDay ≈ cap / emailsPerLead (at equilibrium each day's new cohort's
 * lifetime emails fill the cap) — e.g. 300 people × 3 emails @ 40/day → ~13
 * begin/day, everyone started in ~23 business days. The actual scheduler does
 * the precise per-day fair-share live; this is the rep-facing estimate.
 */
export function computeCapacityPlan(args: {
  leadCount: number;
  emailTouchesPerLead: number;
  dailyCap: number;
}): CapacityPlan {
  const leadCount = Math.max(0, Math.floor(args.leadCount));
  const emailTouchesPerLead = Math.max(0, Math.floor(args.emailTouchesPerLead));
  const dailyCap = Math.max(1, Math.floor(args.dailyCap));

  if (leadCount === 0) {
    return {
      leadCount, emailTouchesPerLead, dailyCap,
      startsPerDay: 0, daysToStartEveryone: 0, emailsPerDayAtSteadyState: 0,
      overCapacity: false, summary: "No one to start yet.", warning: null,
    };
  }
  // No auto-email touches → no cap pressure; everyone can begin at once.
  if (emailTouchesPerLead === 0) {
    return {
      leadCount, emailTouchesPerLead, dailyCap,
      startsPerDay: leadCount, daysToStartEveryone: 1, emailsPerDayAtSteadyState: 0,
      overCapacity: false,
      summary: `${leadCount} ${leadCount === 1 ? "person" : "people"}, no auto-emails — all can begin right away.`,
      warning: null,
    };
  }

  const startsPerDay = Math.max(1, Math.floor(dailyCap / emailTouchesPerLead));
  const daysToStartEveryone = Math.ceil(leadCount / startsPerDay);
  const emailsPerDayAtSteadyState = startsPerDay * emailTouchesPerLead;
  const overCapacity =
    dailyCap < emailTouchesPerLead || daysToStartEveryone > CAPACITY_WARN_BUSINESS_DAYS;

  const summary =
    `${leadCount} ${leadCount === 1 ? "person" : "people"}, ${emailTouchesPerLead} ` +
    `email${emailTouchesPerLead === 1 ? "" : "s"} each, ~${dailyCap}/day → about ` +
    `${startsPerDay} begin per day, everyone started in ~${daysToStartEveryone} business days.`;

  const warning = overCapacity
    ? "This list is bigger than this mailbox can comfortably keep follow-ups on time. " +
      "Consider fewer per day, a second sender, or a longer window."
    : null;

  return {
    leadCount, emailTouchesPerLead, dailyCap,
    startsPerDay, daysToStartEveryone, emailsPerDayAtSteadyState,
    overCapacity, summary, warning,
  };
}

// ── Channel graceful-skip summary (warn at enrollment) ────────────────────────

export interface LeadContactInfo {
  id: string;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  whatsapp_number: string | null;
}

/** True if the lead can receive a touch on this channel. */
export function canReceiveChannel(lead: LeadContactInfo, channel: CanonicalChannel | "linkedin"): boolean {
  switch (channel) {
    case "email": return !!(lead.email && lead.email.includes("@"));
    case "voice":
    case "sms": return !!lead.phone;
    case "whatsapp": return !!(lead.whatsapp_number || lead.phone);
    case "linkedin": return !!lead.linkedin_url;
    default: return false;
  }
}

export interface ChannelSkipSummary {
  // e.g. { voice: 12, linkedin: 5 } — how many leads will skip touches on each channel
  byChannel: Partial<Record<CanonicalChannel | "linkedin", number>>;
  // plain-language lines, e.g. "12 of 40 have no phone — they'll skip the call touches"
  lines: string[];
}

const CHANNEL_REASON: Record<string, string> = {
  voice: "no phone — they'll skip the call touches",
  sms: "no phone — they'll skip the text touches",
  whatsapp: "no WhatsApp number — they'll skip the WhatsApp touches",
  linkedin: "no LinkedIn — they'll skip the LinkedIn touches",
};

/** Summarize, per channel used in the cadence, how many leads can't receive it. */
export function summarizeChannelSkips(
  leads: LeadContactInfo[],
  steps: CadenceStep[],
): ChannelSkipSummary {
  const channelsUsed = Array.from(new Set(steps.map((s) => s.channel)));
  const byChannel: Partial<Record<CanonicalChannel | "linkedin", number>> = {};
  const lines: string[] = [];
  for (const channel of channelsUsed) {
    if (channel === "email") continue; // email handled by validation/suppression, not skip
    const missing = leads.filter((l) => !canReceiveChannel(l, channel)).length;
    if (missing > 0) {
      byChannel[channel] = missing;
      const reason = CHANNEL_REASON[channel] ?? `can't receive ${channel} — they'll skip those touches`;
      lines.push(`${missing} of ${leads.length} ${reason}`);
    }
  }
  return { byChannel, lines };
}

// ── Touch schedule for one lead ───────────────────────────────────────────────

export interface PlannedTouch {
  step_number: number;
  channel: CanonicalChannel | "linkedin";
  eligible_at: string;     // ISO
  max_age_at: string | null; // ISO; manual touches only
}

/**
 * Lay out one lead's touches from its start date. eligible_at[1] = next business
 * day on/after start; each later touch advances by its business-day gap. MANUAL
 * touches get a max_age_at (auto-skip horizon) bounded by the next touch's gap so
 * a stuck manual touch never stalls the cadence; EMAIL touches leave it null
 * (the scheduler manages email staleness).
 */
export function buildTouchSchedule(startDate: Date, steps: CadenceStep[]): PlannedTouch[] {
  const touches: PlannedTouch[] = [];
  let prevEligible = nextBusinessDay(startDate);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const eligible = i === 0 ? prevEligible : addBusinessDays(prevEligible, step.delay_days);
    prevEligible = eligible;

    const isManual = step.channel !== "email";
    let maxAge: Date | null = null;
    if (isManual) {
      const nextGap = i + 1 < steps.length ? steps[i + 1].delay_days : DEFAULT_MAX_AGE_BUSINESS_DAYS;
      const horizon = Math.max(1, Math.min(nextGap || DEFAULT_MAX_AGE_BUSINESS_DAYS, DEFAULT_MAX_AGE_BUSINESS_DAYS));
      maxAge = addBusinessDays(eligible, horizon);
    }
    touches.push({
      step_number: step.step_number,
      channel: step.channel,
      eligible_at: eligible.toISOString(),
      max_age_at: maxAge ? maxAge.toISOString() : null,
    });
  }
  return touches;
}

// ── The enrollment mutation ───────────────────────────────────────────────────

export interface EnrollmentSkips {
  unsubscribed: number;
  suppressed: number;
  alreadyEnrolled: number; // already in a campaign / active sequence
  missingEmail: number;
}

export interface EnrollmentResult {
  enrolled: number;
  skips: EnrollmentSkips;
  channelSkips: ChannelSkipSummary;
  capacity: CapacityPlan;
}

/** The honest plan shown BEFORE committing (no writes). */
export interface EnrollmentPreview {
  enrollableCount: number;
  skips: EnrollmentSkips;
  channelSkips: ChannelSkipSummary;
  capacity: CapacityPlan;
}

interface EnrollCandidateLead extends LeadContactInfo {
  unsubscribed: boolean | null;
  campaign_id: string | null;
  automation_mode: string | null;
  needs_action: boolean | null;
}

interface EnrollmentContext {
  workspaceId: string;
  steps: CadenceStep[];
  enrollable: EnrollCandidateLead[];
  skips: EnrollmentSkips;
  channelSkips: ChannelSkipSummary;
  capacity: CapacityPlan;
  dailyCap: number;
}

/**
 * Shared read + fail-closed partition used by BOTH preview and enroll. Does NOT
 * write anything. The same exclusions run again (race-safe) at write time via
 * the guarded campaign_id stamp, so this is purely the plan.
 */
async function gatherEnrollmentContext(
  campaignId: string,
  leadIds: string[],
  dailyCapOverride?: number,
): Promise<EnrollmentContext> {
  const { data: campaign, error: cErr } = await supabase
    .from("campaigns")
    .select("workspace_id")
    .eq("id", campaignId)
    .single();
  if (cErr || !campaign) throw new Error(cErr?.message || "Outreach not found");
  const workspaceId = (campaign as { workspace_id: string }).workspace_id;

  const { data: stepRows } = await supabase
    .from("campaign_steps")
    .select("step_number, channel, delay_days, active")
    .eq("campaign_id", campaignId)
    .order("step_number", { ascending: true });
  const steps: CadenceStep[] = (stepRows || [])
    .filter((s: any) => s.active !== false)
    .map((s: any) => ({ step_number: s.step_number, channel: s.channel, delay_days: s.delay_days ?? 0 }));
  if (steps.length === 0) throw new Error("This outreach has no active touches to schedule.");

  const { data: leadRows } = await supabase
    .from("leads")
    .select("id, email, phone, linkedin_url, whatsapp_number, unsubscribed, campaign_id, automation_mode, needs_action")
    .in("id", leadIds)
    .eq("workspace_id", workspaceId);
  const leads = (leadRows || []) as unknown as EnrollCandidateLead[];

  const { data: supRows, error: supErr } = await supabase
    .from("campaign_suppression_list" as any)
    .select("kind, value")
    .eq("workspace_id", workspaceId);
  // Fail CLOSED: this is the do-not-contact gate. If the lookup errors (bad RLS,
  // missing grant, transient failure) we must NOT proceed treating the list as
  // empty — that would enroll suppressed leads. Throw instead.
  if (supErr) throw new Error("Couldn't verify the do-not-contact list — enrollment blocked for safety.");
  const suppressedEmails = new Set<string>();
  const suppressedDomains = new Set<string>();
  for (const r of (supRows || []) as any[]) {
    if (r.kind === "email") suppressedEmails.add(String(r.value).toLowerCase());
    else if (r.kind === "domain") suppressedDomains.add(String(r.value).toLowerCase());
  }
  const isSuppressed = (email: string | null): boolean => {
    if (!email) return false;
    const e = email.trim().toLowerCase();
    if (suppressedEmails.has(e)) return true;
    const domain = e.split("@")[1];
    return !!domain && suppressedDomains.has(domain);
  };

  // Leads that already have a schedule for THIS campaign — enrolling is idempotent,
  // so skip them (this is also how "add to a running outreach" avoids re-scheduling).
  const { data: existingEnr } = await supabase
    .from("campaign_enrollment" as any)
    .select("lead_id")
    .eq("campaign_id", campaignId)
    .in("lead_id", leadIds);
  const alreadyEnrolledIds = new Set(((existingEnr || []) as any[]).map((r) => r.lead_id));

  const skips: EnrollmentSkips = { unsubscribed: 0, suppressed: 0, alreadyEnrolled: 0, missingEmail: 0 };
  const enrollable: EnrollCandidateLead[] = [];
  for (const lead of leads) {
    if (!lead.email || !lead.email.includes("@")) { skips.missingEmail++; continue; }
    if (lead.unsubscribed) { skips.unsubscribed++; continue; }
    if (isSuppressed(lead.email)) { skips.suppressed++; continue; }
    if (alreadyEnrolledIds.has(lead.id)) { skips.alreadyEnrolled++; continue; }
    // In a DIFFERENT campaign → never steal it (would silently halt that outreach).
    const inOtherCampaign = lead.campaign_id != null && lead.campaign_id !== campaignId;
    // Has CONSENTED automation (and isn't a member of THIS campaign) → don't
    // double-schedule. The executor's consent gate is `automation_mode IS NOT NULL`
    // (needs_action may be false between due actions), so gate on automation_mode
    // alone — enrolling a consented-but-idle lead would create cold touches while
    // the legacy executor can still resume against it. The rep must clear that
    // lead's automation first.
    const activeLegacy = lead.campaign_id == null && lead.automation_mode != null;
    if (inOtherCampaign || activeLegacy) { skips.alreadyEnrolled++; continue; }
    // Enrollable: unassigned (will be stamped) OR already a member of this campaign.
    enrollable.push(lead);
  }

  const channelSkips = summarizeChannelSkips(enrollable, steps);
  const emailTouchesPerLead = steps.filter((s) => s.channel === "email").length;
  const dailyCap = dailyCapOverride ?? (await fetchDailyCap());
  const capacity = computeCapacityPlan({ leadCount: enrollable.length, emailTouchesPerLead, dailyCap });

  return { workspaceId, steps, enrollable, skips, channelSkips, capacity, dailyCap };
}

/**
 * Compute the honest enrollment plan WITHOUT writing — capacity, channel-skips,
 * and fail-closed exclusion counts — so the rep sees it before committing.
 */
export async function previewEnrollment(
  campaignId: string,
  leadIds: string[],
  dailyCapOverride?: number,
): Promise<EnrollmentPreview> {
  if (leadIds.length === 0) {
    return {
      enrollableCount: 0,
      skips: { unsubscribed: 0, suppressed: 0, alreadyEnrolled: 0, missingEmail: 0 },
      channelSkips: { byChannel: {}, lines: [] },
      capacity: computeCapacityPlan({ leadCount: 0, emailTouchesPerLead: 0, dailyCap: DEFAULT_DAILY_CAP }),
    };
  }
  const ctx = await gatherEnrollmentContext(campaignId, leadIds, dailyCapOverride);
  return {
    enrollableCount: ctx.enrollable.length,
    skips: ctx.skips,
    channelSkips: ctx.channelSkips,
    capacity: ctx.capacity,
  };
}

/** Read the enrolling user's per-mailbox daily auto-email cap (best-effort). */
export async function fetchDailyCap(): Promise<number> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return DEFAULT_DAILY_CAP;
    const { data } = await supabase
      .from("workspace_profiles")
      .select("cadence_settings")
      .eq("user_id", user.id)
      .maybeSingle();
    const cap = (data as any)?.cadence_settings?.guardrails?.max_sends_per_day_per_mailbox;
    return typeof cap === "number" && cap > 0 ? cap : DEFAULT_DAILY_CAP;
  } catch {
    return DEFAULT_DAILY_CAP;
  }
}

/**
 * Enroll leads into a campaign: fail-closed on opt-out / suppression / double
 * scheduling, then lay down a staggered, business-day-aware cadence.
 *
 * Fail-closed exclusions (a lead is enrolled ONLY if it clears all):
 *  - leads.unsubscribed must be false (never cold-email an opt-out).
 *  - not on the workspace do-not-contact list (campaign_suppression_list,
 *    by exact email OR its domain).
 *  - not already in a campaign (campaign_id IS NULL) and not running an active
 *    legacy sequence (no automation_mode + needs_action) — no double-schedule.
 *  - has a syntactically present email (contains "@"). (Strict validation lands
 *    at import in PR 4; here we just refuse to schedule an unsendable address.)
 *
 * The leads.campaign_id stamp is guarded to the campaign's own workspace and to
 * campaign_id IS NULL (reusing the Unit A two-filter pattern), so a multi-
 * workspace rep can't pull a cross-workspace lead in and we never steal a lead
 * out of an outreach it already belongs to.
 */
export async function enrollLeadsInCampaign(
  campaignId: string,
  leadIds: string[],
  opts?: { dailyCap?: number; anchor?: Date },
): Promise<EnrollmentResult> {
  const emptySkips: EnrollmentSkips = { unsubscribed: 0, suppressed: 0, alreadyEnrolled: 0, missingEmail: 0 };
  if (leadIds.length === 0) {
    return {
      enrolled: 0, skips: emptySkips,
      channelSkips: { byChannel: {}, lines: [] },
      capacity: computeCapacityPlan({ leadCount: 0, emailTouchesPerLead: 0, dailyCap: DEFAULT_DAILY_CAP }),
    };
  }

  const { workspaceId, steps, enrollable, skips, channelSkips, capacity, dailyCap } =
    await gatherEnrollmentContext(campaignId, leadIds, opts?.dailyCap);

  if (enrollable.length === 0) {
    return { enrolled: 0, skips, channelSkips, capacity };
  }

  // Existing members of THIS campaign are already stamped — schedule them directly.
  const members = enrollable.filter((l) => l.campaign_id === campaignId);
  // Unassigned leads need their campaign_id stamped, guarded (workspace + IS NULL),
  // so a multi-workspace rep can't pull a cross-workspace lead in and a lead claimed
  // by a concurrent enrollment between our read and write is excluded.
  const toStampIds = enrollable.filter((l) => l.campaign_id == null).map((l) => l.id);
  const stampedLeads: EnrollCandidateLead[] = [...members];
  // IDs whose campaign_id THIS call set (excludes pre-existing members). Only these
  // may be cleared on rollback — clearing members would evict them from the outreach.
  const newlyStampedIds: string[] = [];
  if (toStampIds.length > 0) {
    const { data: stampedRows, error: stampErr } = await supabase
      .from("leads")
      .update({ campaign_id: campaignId } as any)
      .in("id", toStampIds)
      .eq("workspace_id", workspaceId)
      .is("campaign_id", null)
      .select("id");
    if (stampErr) throw new Error(stampErr.message || "Failed to enroll people");
    const stampedIds = new Set(((stampedRows || []) as any[]).map((r) => r.id));
    skips.alreadyEnrolled += toStampIds.length - stampedIds.size; // claimed concurrently
    newlyStampedIds.push(...stampedIds);
    stampedLeads.push(...enrollable.filter((l) => stampedIds.has(l.id)));
  }
  if (stampedLeads.length === 0) {
    return { enrolled: 0, skips, channelSkips, capacity };
  }

  // Staggered start day per lead. Seed the planner with the EXISTING scheduled/
  // queued email-touch load for this campaign so adding people to a RUNNING outreach
  // doesn't pile new follow-ups onto business days already at the daily cap.
  const anchor = opts?.anchor ?? new Date();
  const offsets = emailOffsets(steps);
  // Seed from the mailbox's WHOLE scheduled/queued email-touch load, not just this
  // campaign — the daily cap is per-mailbox and spans every outreach, so other
  // campaigns' booked email days must count too. RLS scopes this to the rep's
  // workspace (a safe, slightly conservative proxy for per-mailbox); the executor
  // enforces the precise per-owner daily cap at send time regardless.
  const { data: existingEmailTouches } = await supabase
    .from("campaign_touch" as any)
    .select("eligible_at")
    .eq("channel", "email")
    .in("status", ["scheduled", "queued"])
    .not("eligible_at", "is", null);
  const initialLoad: Record<number, number> = {};
  for (const et of (existingEmailTouches || []) as any[]) {
    const off = businessDayOffset(anchor, new Date(et.eligible_at));
    initialLoad[off] = (initialLoad[off] ?? 0) + 1;
  }
  const starts = computeStaggeredStarts(stampedLeads.length, offsets, dailyCap, initialLoad);

  const enrollmentRows = stampedLeads.map((lead, i) => ({
    campaign_id: campaignId,
    lead_id: lead.id,
    status: "scheduled",
    current_step_number: 0,
    started_at: addBusinessDays(anchor, starts[i]).toISOString(),
  }));
  const { data: insertedEnrollments, error: enrErr } = await supabase
    .from("campaign_enrollment" as any)
    .insert(enrollmentRows as any)
    .select("id, lead_id, started_at");
  if (enrErr) {
    // Roll back ONLY the campaign_id values this call stamped — never members that
    // were already in the outreach before this call.
    if (newlyStampedIds.length > 0) {
      await supabase.from("leads").update({ campaign_id: null } as any).in("id", newlyStampedIds);
    }
    throw new Error(enrErr.message || "Failed to create enrollments");
  }

  // Touch rows for every enrollment.
  const touchRows: any[] = [];
  for (const enr of (insertedEnrollments || []) as any[]) {
    const schedule = buildTouchSchedule(new Date(enr.started_at), steps);
    for (const t of schedule) {
      touchRows.push({
        enrollment_id: enr.id,
        campaign_id: campaignId,
        lead_id: enr.lead_id,
        step_number: t.step_number,
        channel: t.channel,
        status: "scheduled",
        eligible_at: t.eligible_at,
        max_age_at: t.max_age_at,
      });
    }
  }
  if (touchRows.length > 0) {
    const { error: touchErr } = await supabase
      .from("campaign_touch" as any)
      .insert(touchRows as any);
    if (touchErr) {
      // Atomicity: a touch-insert failure would otherwise strand leads as enrolled
      // with NO cadence (and a later retry skips them as already-enrolled). Roll the
      // enrollment back to its pre-call state: delete the enrollment rows we just
      // created and clear ONLY the campaign_id values this call stamped (members keep
      // theirs). Any partial touch rows cascade-delete with their enrollment.
      const enrIds = ((insertedEnrollments || []) as any[]).map((e) => e.id);
      if (enrIds.length > 0) {
        await supabase.from("campaign_enrollment" as any).delete().in("id", enrIds);
      }
      if (newlyStampedIds.length > 0) {
        await supabase.from("leads").update({ campaign_id: null } as any).in("id", newlyStampedIds);
      }
      throw new Error(touchErr.message || "Failed to schedule touches");
    }
  }

  return { enrolled: stampedLeads.length, skips, channelSkips, capacity };
}

/**
 * Remove a lead from a campaign — the proper counterpart to enrollment now that
 * campaign_enrollment / campaign_touch are the scheduler's source of truth.
 * Deletes the enrollment row (campaign_touch cascades via FK) so the scheduler and
 * executor immediately stop processing the lead, THEN clears leads.campaign_id.
 * Just clearing campaign_id (the old removal path) would leave the schedule rows
 * behind and the cold cadence would keep running.
 */
export async function unenrollLeadFromCampaign(campaignId: string, leadId: string): Promise<void> {
  const { error: delErr } = await supabase
    .from("campaign_enrollment" as any)
    .delete()
    .eq("campaign_id", campaignId)
    .eq("lead_id", leadId);
  if (delErr) throw new Error(delErr.message || "Couldn't stop the schedule");

  const { error: updErr } = await supabase
    .from("leads")
    .update({ campaign_id: null } as any)
    .eq("id", leadId)
    .eq("campaign_id", campaignId); // only clear if the lead is still in THIS campaign
  if (updErr) throw new Error(updErr.message || "Couldn't remove the person");
}
