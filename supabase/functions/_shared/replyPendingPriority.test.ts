// Regression tests: an UNANSWERED customer reply must always surface as
// `reply_now`, even when the lead is inside a send guardrail or has an armed
// cadence touch. Both paths previously swallowed the reply, which is why cold
// outreach replies never reached the Queue's Replied / Follow up tabs.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_CADENCE_SETTINGS,
  deriveAction,
  buildLeadUpdate,
  type LeadMetrics,
} from "./syncEngine.ts";

const S = DEFAULT_CADENCE_SETTINGS;
const MODE = S.modes.fast; // reply_pending_hours = 4
const HOUR = 60 * 60 * 1000;

function metricsWithUnansweredReply(): LeadMetrics {
  const now = Date.now();
  return {
    first_outbound_at: new Date(now - 10 * 24 * HOUR).toISOString(),
    // Outbound TODAY (trips same_day_send_allowed=false + min_gap_hours=16)
    last_outbound_at: new Date(now - 8 * HOUR).toISOString(),
    // Customer replied 6h ago — after our send, past reply_pending_hours (4h)
    last_inbound_at: new Date(now - 6 * HOUR).toISOString(),
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  } as unknown as LeadMetrics;
}

function derive(metrics: LeadMetrics, out7d: number, out30d: number) {
  return deriveAction(
    "lead-1",
    metrics,
    null,
    "engaged",
    false,
    false,
    out7d,
    out30d,
    MODE,
    S.guardrails,
    S.stop_pause_rules,
    S.flows,
    "UTC",
    "balanced",
    "outbound_prospecting",
  );
}

Deno.test("reply_now wins over the 7d send cap", () => {
  const r = derive(metricsWithUnansweredReply(), S.guardrails.max_emails_per_lead_per_7d, 0);
  assertEquals(r.next_action_key, "reply_now");
  assertEquals(r.needs_action, true);
  assertEquals(r.action_reason_code, "REPLY_PENDING");
});

Deno.test("reply_now wins over the 30d send cap", () => {
  const r = derive(metricsWithUnansweredReply(), 0, S.guardrails.max_emails_per_lead_per_30d);
  assertEquals(r.next_action_key, "reply_now");
  assertEquals(r.needs_action, true);
});

Deno.test("reply_now wins over min_gap_hours / same-day-send guardrails", () => {
  // out7d/out30d well under the caps — only the recency guardrails apply.
  const r = derive(metricsWithUnansweredReply(), 1, 1);
  assertEquals(r.next_action_key, "reply_now");
  assertEquals(r.needs_action, true);
});

// ── Guardrails with nobody waiting on us (Unit Q1 split this in two) ──
//
// The four send guardrails no longer behave alike, and the pairing below is
// the whole change in one place: the multi-day VOLUME caps surface, the
// short-gap rules stay silent.

function metricsQuietSince(hoursAgo: number): LeadMetrics {
  const now = Date.now();
  return {
    first_outbound_at: new Date(now - 10 * 24 * HOUR).toISOString(),
    last_outbound_at: new Date(now - hoursAgo * HOUR).toISOString(),
    last_inbound_at: null,
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  } as unknown as LeadMetrics;
}

Deno.test("7d volume cap surfaces as rate_limited instead of vanishing", () => {
  // Was asserted silent before Unit Q1. A lead held for days by a volume cap
  // used to drop out of the Queue with no key, no reason and no date; it now
  // stays visible and says when the automatic send resumes.
  const r = derive(metricsQuietSince(8), S.guardrails.max_emails_per_lead_per_7d, 0);
  assertEquals(r.needs_action, true);
  assertEquals(r.next_action_key, "rate_limited");
  assertEquals(r.action_reason_code, "RATE_LIMITED");
  assert(new Date(r.eligible_at!).getTime() > Date.now());
  // Names the AUTOMATIC send as what is paused — the rep may still write now.
  assert(r.next_action_label!.startsWith("Follow up anytime — auto-send paused until "));
});

Deno.test("30d volume cap surfaces as rate_limited too", () => {
  const r = derive(metricsQuietSince(8), 0, S.guardrails.max_emails_per_lead_per_30d);
  assertEquals(r.next_action_key, "rate_limited");
  assertEquals(r.needs_action, true);
});

Deno.test("min_gap / same-day guardrails still go silent (unchanged behaviour)", () => {
  // The companion invariant. These two trip on every lead the rep just
  // emailed, and postSendDeriveAction recomputes seconds after a send — if
  // they surfaced, every sent email would bounce straight back into the Queue
  // as a no-op card and the Queue would never empty. Same branch serves the
  // same-day rule; the min-gap window is asserted here because a >16h same-day
  // send only exists late in the UTC day and would make this test clock-flaky.
  for (const hours of [0.2, 8]) {
    const r = derive(metricsQuietSince(hours), 1, 1);
    assertEquals(r.needs_action, false, `quiet ${hours}h`);
    assertEquals(r.next_action_key, null, `quiet ${hours}h`);
  }
});

Deno.test("buildLeadUpdate preserves reply_now when a cadence touch is armed", () => {
  const metrics = metricsWithUnansweredReply();
  const action = {
    needs_action: true,
    next_action_key: "reply_now",
    next_action_label: "Reply to customer",
    eligible_at: new Date(Date.now() - HOUR).toISOString(),
    action_reason_code: "REPLY_PENDING",
  };
  const update = buildLeadUpdate("engaged", metrics, action as never, null, {
    needs_action: true,
    // Future eligible_at = hasActiveSequence -> used to blank next_action_key
    eligible_at: new Date(Date.now() + 24 * HOUR).toISOString(),
    motion: "outbound_prospecting",
    nurture_status: "inactive",
    ooo_until: null,
  }, "auto");

  assertEquals(update.next_action_key, "reply_now");
  assertEquals(update.needs_action, true);
});

Deno.test("buildLeadUpdate still suppresses send_* keys when a cadence touch is armed", () => {
  const metrics = metricsWithUnansweredReply();
  const action = {
    needs_action: true,
    next_action_key: "send_pre_3",
    next_action_label: "Send follow-up Email 3",
    eligible_at: new Date(Date.now() - HOUR).toISOString(),
    action_reason_code: "FOLLOWUP_DUE",
  };
  const update = buildLeadUpdate("contacted", metrics, action as never, null, {
    needs_action: true,
    eligible_at: new Date(Date.now() + 24 * HOUR).toISOString(),
    motion: "outbound_prospecting",
    nurture_status: "inactive",
    ooo_until: null,
  }, "auto");

  assertEquals(update.next_action_key, null);
});
