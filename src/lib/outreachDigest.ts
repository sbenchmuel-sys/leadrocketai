// ============================================================================
// Outreach daily digest (Sprint 3) — "what's on today" for the Outreach tab.
//
// Three questions a rep asks before they start:
//   1. What's due today?           due now (queued) + later today (next-in-line,
//                                  scheduled, before end of day) — per channel.
//   2. What got auto-skipped       the system_note timeline items
//      yesterday, and why?         advanceColdEnrollment writes (BUG-018), grouped
//                                  by reason, with the people affected.
//   3. What's overdue?             queued touches whose due time was before today
//                                  started — still sitting in the Queue.
//
// In-app only (no rep-facing email sender exists; adding one is a separate
// PR). All windows are calendar days in WORKSPACE time (startOfDayInTz), so two
// reps in different zones read the same digest. Owner-scoped like the Queue:
// every query inner-joins leads so RLS drops colleagues' leads server-side.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";
import { OUTREACH_CHANNELS, type OutreachChannel } from "@/lib/outreachQueue";
import { startOfDayInTz } from "@/lib/eligibleAtFormat";

export interface SkipReasonGroup {
  reason: string;
  count: number;
  /** Up to a few names, for "who" without a full list. */
  leadNames: string[];
}

export interface OutreachDigest {
  /** Next-in-line touches due later today (not yet surfaced), per channel. */
  laterToday: Record<OutreachChannel, number>;
  /** True when the scheduled-today read hit ROW_CAP — laterToday is a floor, not an exact count. */
  laterTodayTruncated: boolean;
  /** Queued touches whose due time fell before today started, per channel (exact server counts). */
  overdue: Record<OutreachChannel, number>;
  overdueTotal: number;
  /** Auto-skips from yesterday's calendar day, grouped by reason. */
  skippedYesterday: SkipReasonGroup[];
  skippedYesterdayTotal: number;
  /** True when the notes read hit ROW_CAP — the groups cover the first ROW_CAP notes only. */
  skippedYesterdayTruncated: boolean;
}

const emptyCounts = (): Record<OutreachChannel, number> =>
  ({ email: 0, voice: 0, sms: 0, whatsapp: 0, linkedin: 0 });

const NAMES_PER_REASON = 3;

// Bound each row read; a digest is a summary, not a ledger. When a read hits the
// cap the digest SAYS so (truncated flags → "500+" in the UI) instead of passing
// a partial page off as the total. Overdue uses exact server-side counts.
export const ROW_CAP = 500;

/** Raw inputs the digest is folded from — the shape the queries return. */
export interface DigestInputs {
  /** Scheduled touches with eligible_at ≤ end of today, with their enrollment cursor. */
  scheduledToday: { channel: string; step_number: number; current_step_number: number; enrollment_status: string }[];
  /** Queued touches with eligible_at < start of today — exact count per channel. */
  overdueByChannel: Record<OutreachChannel, number>;
  /** Auto-skip notes from yesterday. */
  skipNotes: { reason: string | null; lead_name: string | null }[];
}

/** Pure fold — exported for the unit test. */
export function buildDigest(input: DigestInputs): OutreachDigest {
  const laterToday = emptyCounts();
  for (const t of input.scheduledToday) {
    // Every future touch is pre-created as 'scheduled'; only the NEXT-IN-LINE one
    // (cursor + 1) of a live enrollment can actually surface today.
    if (t.step_number !== t.current_step_number + 1) continue;
    if (t.enrollment_status !== "scheduled" && t.enrollment_status !== "active") continue;
    if ((OUTREACH_CHANNELS as string[]).includes(t.channel)) laterToday[t.channel as OutreachChannel]++;
  }

  const overdue = { ...emptyCounts(), ...input.overdueByChannel };
  const overdueTotal = OUTREACH_CHANNELS.reduce((n, ch) => n + overdue[ch], 0);

  const byReason = new Map<string, SkipReasonGroup>();
  for (const n of input.skipNotes) {
    const reason = (n.reason || "the step's window passed").trim();
    const g = byReason.get(reason) ?? { reason, count: 0, leadNames: [] };
    g.count++;
    if (n.lead_name && g.leadNames.length < NAMES_PER_REASON && !g.leadNames.includes(n.lead_name)) {
      g.leadNames.push(n.lead_name);
    }
    byReason.set(reason, g);
  }
  const skippedYesterday = [...byReason.values()].sort((a, b) => b.count - a.count);

  return {
    laterToday,
    laterTodayTruncated: input.scheduledToday.length >= ROW_CAP,
    overdue,
    overdueTotal,
    skippedYesterday,
    skippedYesterdayTotal: skippedYesterday.reduce((n, g) => n + g.count, 0),
    skippedYesterdayTruncated: input.skipNotes.length >= ROW_CAP,
  };
}

export async function fetchOutreachDigest(
  workspaceTz: string | null | undefined,
  now: Date = new Date(),
): Promise<OutreachDigest> {
  const startToday = startOfDayInTz(now, workspaceTz).toISOString();
  const startTomorrow = startOfDayInTz(now, workspaceTz, 1).toISOString();
  const startYesterday = startOfDayInTz(now, workspaceTz, -1).toISOString();
  const nowIso = now.toISOString();

  const { data: activeCamps } = await supabase.from("campaigns").select("id").eq("status", "active");
  const activeIds = ((activeCamps || []) as { id: string }[]).map((c) => c.id);

  // Yesterday's skip notes are history — they still count with no campaign active
  // today (the rep may have paused their last one since). Only the forward-looking
  // reads need an active campaign.
  const none = Promise.resolve({ data: null, count: null });
  const [scheduledRes, notesRes, ...overdueRes] = await Promise.all([
    activeIds.length === 0 ? none : supabase
      .from("campaign_touch" as any)
      .select("channel, step_number, leads!inner(id), campaign_enrollment!inner(current_step_number, status)")
      .eq("status", "scheduled")
      .in("campaign_id", activeIds)
      .gt("eligible_at", nowIso)
      .lt("eligible_at", startTomorrow)
      .order("eligible_at", { ascending: true })
      .limit(ROW_CAP),
    supabase
      .from("lead_timeline_items")
      .select("metadata_json, leads!inner(name)")
      .eq("event_type", "system_note")
      .like("dedupe_key", "cold_auto_skip_%")
      .gte("occurred_at", startYesterday)
      .lt("occurred_at", startToday)
      .order("occurred_at", { ascending: false })
      .limit(ROW_CAP),
    // Overdue: exact HEAD counts per channel, same filters as the queue.
    ...OUTREACH_CHANNELS.map((ch) =>
      activeIds.length === 0 ? none : supabase
        .from("campaign_touch" as any)
        .select("id, leads!inner(id)", { count: "exact", head: true })
        .eq("status", "queued")
        .eq("channel", ch)
        .in("campaign_id", activeIds)
        .lt("eligible_at", startToday),
    ),
  ]);
  const overdueByChannel = emptyCounts();
  OUTREACH_CHANNELS.forEach((ch, i) => { overdueByChannel[ch] = (overdueRes[i] as { count: number | null }).count ?? 0; });
  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

  return buildDigest({
    scheduledToday: ((scheduledRes.data || []) as any[]).map((t) => {
      const enr = one<any>(t.campaign_enrollment) || {};
      return {
        channel: t.channel,
        step_number: t.step_number,
        current_step_number: enr.current_step_number ?? 0,
        enrollment_status: enr.status ?? "",
      };
    }),
    overdueByChannel,
    skipNotes: ((notesRes.data || []) as any[]).map((n) => ({
      reason: n.metadata_json?.auto_skip_reason ?? null,
      lead_name: one<any>(n.leads)?.name ?? null,
    })),
  });
}
