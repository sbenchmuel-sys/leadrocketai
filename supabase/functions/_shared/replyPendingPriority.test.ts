// Regression tests: an UNANSWERED customer reply must always surface as
// `reply_now`, even when the lead is inside a send guardrail or has an armed
// cadence touch. Both paths previously swallowed the reply, which is why cold
// outreach replies never reached the Queue's Replied / Follow up tabs.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
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

Deno.test("no unanswered inbound still hits the guardrail (unchanged behaviour)", () => {
  const now = Date.now();
  const m = {
    first_outbound_at: new Date(now - 10 * 24 * HOUR).toISOString(),
    last_outbound_at: new Date(now - 8 * HOUR).toISOString(),
    last_inbound_at: null,
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  } as unknown as LeadMetrics;
  const r = derive(m, S.guardrails.max_emails_per_lead_per_7d, 0);
  assertEquals(r.needs_action, false);
  assertEquals(r.next_action_key, null);
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
