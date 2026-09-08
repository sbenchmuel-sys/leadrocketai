// Unit Q1 — end-to-end coverage of the follow-up rule THROUGH deriveAction.
//
// The pure rule and the key registry are covered by vitest
// (src/test/followupRule.test.ts); syncEngine itself can't be imported from
// src/ (it reads Deno.env), so the full branch interaction lives here.
//
// Run with `npm run test:edge`. NOTE: this suite could not be executed in the
// build sandbox — deno.land / esm.sh are blocked by network policy.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildLeadUpdate,
  DEFAULT_CADENCE_SETTINGS,
  deriveAction,
  type LeadMetrics,
} from "./syncEngine.ts";

const S = DEFAULT_CADENCE_SETTINGS;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function metrics(partial: Partial<LeadMetrics>): LeadMetrics {
  return {
    first_outbound_at: null,
    last_outbound_at: null,
    last_inbound_at: null,
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
    ...partial,
  };
}

function derive(
  m: LeadMetrics,
  opts: { stage?: string; strategy?: string; out7d?: number; out30d?: number; mode?: typeof S.modes.fast } = {},
) {
  const strategy = opts.strategy ?? "fast";
  return deriveAction(
    "lead-q1",
    m,
    null,
    opts.stage ?? "engaged",
    false,
    false,
    opts.out7d ?? 0,
    opts.out30d ?? 0,
    opts.mode ?? (strategy === "nurture" ? S.modes.nurture : S.modes.fast),
    S.guardrails,
    S.stop_pause_rules,
    S.flows,
    "UTC",
    strategy,
    "outbound_prospecting",
  );
}

// ── The six-week hole ──────────────────────────────────────────────

Deno.test("warm lead who replied 2 months ago and was emailed 4 days ago → followup_due", () => {
  const r = derive(metrics({
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(60),
    last_outbound_at: daysAgo(4),
  }));
  assertEquals(r.next_action_key, "followup_due");
  assertEquals(r.needs_action, true);
  assertEquals(r.action_reason_code, "FOLLOWUP_DUE");
});

Deno.test("a fresh inbound still wins — reply_now, never followup_due", () => {
  const r = derive(metrics({
    first_outbound_at: daysAgo(70),
    last_outbound_at: daysAgo(4),
    last_inbound_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
  }));
  assertEquals(r.next_action_key, "reply_now");
});

Deno.test("nurture waits 5 days where fast waits 3", () => {
  const m = metrics({
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(60),
    last_outbound_at: daysAgo(4),
  });
  assertEquals(derive(m, { strategy: "fast" }).next_action_key, "followup_due");
  assertEquals(derive(m, { strategy: "nurture" }).next_action_key, null);
});

Deno.test("workspace override changes the wait", () => {
  const m = metrics({
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(60),
    last_outbound_at: daysAgo(4),
  });
  const slower = { ...S.modes.fast, followup_wait_days: 10 };
  assertEquals(derive(m, { mode: slower }).next_action_key, null);
});

// ── Existing keys keep winning where they already fired ────────────

Deno.test("closing stage still gets closing_followup, not followup_due", () => {
  const r = derive(
    metrics({ first_outbound_at: daysAgo(20), last_inbound_at: daysAgo(10), last_outbound_at: daysAgo(4) }),
    { stage: "closing" },
  );
  assertEquals(r.next_action_key, "closing_followup");
});

Deno.test("cold cadence still gets send_pre_N, not followup_due", () => {
  const r = derive(metrics({ first_outbound_at: daysAgo(4), last_outbound_at: daysAgo(4) }), {
    stage: "contacted",
  });
  assert(r.next_action_key?.startsWith("send_pre_"), `got ${r.next_action_key}`);
});

Deno.test("post-meeting still gets post_meeting_followup", () => {
  const r = derive(
    metrics({
      first_outbound_at: daysAgo(30),
      last_inbound_at: daysAgo(20),
      last_outbound_at: daysAgo(9),
      meeting_summary_count: 1,
    }),
    { stage: "post_meeting" },
  );
  assertEquals(r.next_action_key, "post_meeting_followup");
});

// ── Guardrails are visible, not silent ─────────────────────────────

Deno.test("same-day guardrail → rate_limited with a future date, still needs_action", () => {
  const r = derive(metrics({
    first_outbound_at: daysAgo(30),
    last_inbound_at: daysAgo(20),
    last_outbound_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  }));
  assertEquals(r.next_action_key, "rate_limited");
  assertEquals(r.needs_action, true);
  assert(new Date(r.eligible_at!).getTime() > Date.now());
  assert(r.next_action_label!.startsWith("Follow up available "));
});

Deno.test("7d cap does not hide a follow-up that is already owed", () => {
  const r = derive(
    metrics({ first_outbound_at: daysAgo(30), last_inbound_at: daysAgo(20), last_outbound_at: daysAgo(4) }),
    { out7d: S.guardrails.max_emails_per_lead_per_7d },
  );
  assertEquals(r.next_action_key, "followup_due");
});

// ── Never a send trigger ───────────────────────────────────────────

Deno.test("buildLeadUpdate persists followup_due / rate_limited without eligible_at", () => {
  const m = metrics({
    first_outbound_at: daysAgo(30),
    last_inbound_at: daysAgo(20),
    last_outbound_at: daysAgo(4),
  });
  const action = derive(m);
  assertEquals(action.next_action_key, "followup_due");
  // automation_mode set = lead is enrolled in automation. The executor selects
  // on needs_action + eligible_at, not on the key, so eligible_at MUST be null.
  const update = buildLeadUpdate("engaged", m, action, null, null, "reactive");
  assertEquals(update.next_action_key, "followup_due");
  assertEquals(update.needs_action, true);
  assertEquals(update.eligible_at, null);
});

Deno.test("an armed cadence no longer blanks the follow-up prompt", () => {
  const m = metrics({
    first_outbound_at: daysAgo(30),
    last_inbound_at: daysAgo(20),
    last_outbound_at: daysAgo(4),
  });
  const action = derive(m);
  const update = buildLeadUpdate("engaged", m, action, null, {
    needs_action: true,
    eligible_at: new Date(Date.now() + 2 * DAY).toISOString(),
    motion: "outbound_prospecting",
    nurture_status: "",
    ooo_until: null,
  }, "reactive");
  assertEquals(update.next_action_key, "followup_due");
  assertEquals(update.eligible_at, null);
});
