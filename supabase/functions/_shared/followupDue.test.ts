// Unit Q1 — end-to-end coverage of the follow-up rule THROUGH deriveAction.
//
// The pure rule and the key registry are covered by vitest
// (src/test/followupRule.test.ts); syncEngine itself can't be imported from
// src/ (it reads Deno.env), so the full branch interaction lives here.
//
// Run with `npm run test:edge`. NOTE: this suite could not be executed in the
// build sandbox — deno.land / esm.sh are blocked by network policy.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveAction as bulkDeriveAction } from "./bulkSyncAction.ts";
import { mustClearEligibleAt } from "./followupRule.ts";
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

Deno.test("post-meeting stays quiet until ITS 7-day rule, then uses its own key", () => {
  // The generic 3-day fallback must not overtake D2's deliberate 7-day wait.
  const at = (days: number) => metrics({
    first_outbound_at: daysAgo(60),
    last_inbound_at: daysAgo(30),
    last_outbound_at: daysAgo(days),
    meeting_summary_count: 1,
  });
  assertEquals(derive(at(4), { stage: "post_meeting" }).next_action_key, null);
  assertEquals(derive(at(7), { stage: "post_meeting" }).next_action_key, "post_meeting_followup");
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

Deno.test("a lead emailed 10 minutes ago stays silent — the Queue must still empty", () => {
  // The 16-hour-gap and same-day guardrails trip on every lead the rep just
  // emailed, and postSendDeriveAction recomputes seconds after the send.
  const r = derive(metrics({
    first_outbound_at: daysAgo(30),
    last_inbound_at: daysAgo(20),
    last_outbound_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  }));
  assertEquals(r.next_action_key, null);
  assertEquals(r.needs_action, false);
});

Deno.test("7d volume cap → rate_limited with a future date, still needs_action", () => {
  const r = derive(
    metrics({ first_outbound_at: daysAgo(30), last_inbound_at: daysAgo(20), last_outbound_at: daysAgo(1) }),
    { out7d: S.guardrails.max_emails_per_lead_per_7d },
  );
  assertEquals(r.next_action_key, "rate_limited");
  assertEquals(r.needs_action, true);
  assert(new Date(r.eligible_at!).getTime() > Date.now());
  // Names the AUTOMATIC send as what is paused — the rep can still write now.
  assert(r.next_action_label!.startsWith("Follow up anytime — auto-send paused until "));
});

Deno.test("7d cap does not hide a follow-up that is already owed", () => {
  const r = derive(
    metrics({ first_outbound_at: daysAgo(30), last_inbound_at: daysAgo(20), last_outbound_at: daysAgo(4) }),
    { out7d: S.guardrails.max_emails_per_lead_per_7d },
  );
  assertEquals(r.next_action_key, "followup_due");
});

Deno.test("a reply inside the reply-pending window is never buried under rate_limited", () => {
  const r = derive(
    metrics({
      first_outbound_at: daysAgo(30),
      last_outbound_at: daysAgo(4),
      last_inbound_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }),
    { out7d: S.guardrails.max_emails_per_lead_per_7d },
  );
  assertEquals(r.next_action_key, null);
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

Deno.test("an armed cadence is left ENTIRELY alone — no field of it is written", () => {
  // The cadence will send the follow-up itself, so the Queue prompt is
  // redundant here; letting it through would also discard `eligible_at`.
  const m = metrics({
    first_outbound_at: daysAgo(30),
    last_inbound_at: daysAgo(20),
    last_outbound_at: daysAgo(4),
  });
  const armedAt = new Date(Date.now() + 2 * DAY).toISOString();
  const update = buildLeadUpdate("engaged", m, derive(m), null, {
    needs_action: true,
    eligible_at: armedAt,
    motion: "outbound_prospecting",
    nurture_status: "",
    ooo_until: null,
  }, "reactive");
  // Absent, not null. Nulling `next_action_key` while keeping needs_action and
  // a future eligible_at silently kills the send: automation-executor ends its
  // candidate query with `.neq("next_action_key", "ooo_return_followup")`, and
  // `NULL <> 'x'` is UNKNOWN, so the row is never selected again. The post-send
  // recompute races the client's own `updateSequenceState` write, so the only
  // correct move is to touch none of these columns.
  for (const field of ["needs_action", "next_action_key", "next_action_label", "action_reason_code", "eligible_at"]) {
    assertEquals(field in update, false, field);
  }
});

Deno.test("suppression needs a FUTURE anchor, so a preserved key can never be permanent", () => {
  const m = metrics({
    first_outbound_at: daysAgo(30),
    last_inbound_at: daysAgo(20),
    last_outbound_at: daysAgo(4),
  });
  const update = buildLeadUpdate("engaged", m, derive(m), null, {
    needs_action: true,
    eligible_at: daysAgo(1), // the scheduled moment has passed
    motion: "outbound_prospecting",
    nurture_status: "",
    ooo_until: null,
  }, "reactive");
  assertEquals(update.next_action_key, "followup_due");
});




// ── Closed deals are done ──────────────────────────────────────────

Deno.test("a closed deal is never chased for a follow-up", () => {
  const m = metrics({
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(30),
    last_outbound_at: daysAgo(10),
  });
  for (const stage of ["closed_won", "closed_lost"]) {
    const r = derive(m, { stage });
    assertEquals(r.next_action_key, null, stage);
    assertEquals(r.needs_action, false, stage);
  }
  // Guard is not vacuous: the same lead still surfaces while the deal is open.
  assertEquals(derive(m, { stage: "engaged" }).next_action_key, "followup_due");
});

Deno.test("a customer writing after the close still surfaces", () => {
  const r = derive(
    metrics({
      first_outbound_at: daysAgo(70),
      last_outbound_at: daysAgo(10),
      last_inbound_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    }),
    { stage: "closed_won" },
  );
  assertEquals(r.next_action_key, "reply_now");
});

// ── The scheduled Gmail path (gmail-bulk-sync's own rule) ──────────

Deno.test("gmail-bulk-sync surfaces a Gmail lead emailed 4 days ago and quiet since", () => {
  // This is the ONLY Gmail path on a cron, and its private rule returned null
  // here — then wrote that null over the shared rule's followup_due.
  const warmAndQuiet = {
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(60),
    last_outbound_at: daysAgo(4),
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  };
  const r = bulkDeriveAction(warmAndQuiet, 0, null, "engaged", "fast");
  assertEquals(r.next_action_key, "followup_due");
  assertEquals(r.needs_action, true);

  // Nurture waits longer, and a closed deal is never chased.
  assertEquals(bulkDeriveAction(warmAndQuiet, 0, null, "engaged", "nurture").next_action_key, null);
  assertEquals(bulkDeriveAction(warmAndQuiet, 0, null, "closed_won", "fast").next_action_key, null);

  // Existing verdicts unchanged.
  assertEquals(
    bulkDeriveAction({ ...warmAndQuiet, last_inbound_at: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString() },
      0, null, "engaged", "fast").next_action_key,
    "reply_now",
  );
  assertEquals(bulkDeriveAction(warmAndQuiet, 0, null, "closing", "fast").next_action_key, "closing_followup");
});


// ── THE INVARIANT ──────────────────────────────────────────────────

Deno.test("a prompt-only key always requires eligible_at to be nulled", () => {
  assertEquals(mustClearEligibleAt("followup_due"), true);
  assertEquals(mustClearEligibleAt("rate_limited"), true);
  assertEquals(mustClearEligibleAt("send_pre_2"), false);
  assertEquals(mustClearEligibleAt(null), false);
});

Deno.test("buildLeadUpdate nulls eligible_at even when the stored one has PASSED", () => {
  // The shape gmail-bulk-sync got wrong: a past eligible_at is not caught by
  // any "is automation scheduled" guard, so it survives beside the new key
  // unless the writer nulls it explicitly.
  const m = metrics({
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(60),
    last_outbound_at: daysAgo(4),
  });
  const update = buildLeadUpdate("engaged", m, derive(m), null, {
    needs_action: false,
    eligible_at: daysAgo(2), // already passed → executor would fire on it
    motion: "outbound_prospecting",
    nurture_status: "",
    ooo_until: null,
  }, "reactive");
  assertEquals(update.next_action_key, "followup_due");
  assertEquals(update.eligible_at, null);
});

Deno.test("the workspace wait override reaches gmail-bulk-sync's rule", () => {
  const warmAndQuiet = {
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(60),
    last_outbound_at: daysAgo(4),
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  };
  assertEquals(
    bulkDeriveAction(warmAndQuiet, 0, null, "engaged", "fast", { followup_wait_days: 10 }).next_action_key,
    null,
  );
  assertEquals(
    bulkDeriveAction(warmAndQuiet, 0, null, "engaged", "nurture", { followup_wait_days: 2 }).next_action_key,
    "followup_due",
  );
});


// ── The sweep must not erase a verdict it cannot compute ───────────

Deno.test("gmail-bulk-sync's rule has no rate_limited in its vocabulary", () => {
  // The premise of the preserve-guard in gmail-bulk-sync: this rule takes no
  // guardrails and no outbound counts, so it can only ever return something
  // else — which is why its verdict must not overwrite an active rate_limited.
  const quietAfterACappedBurst = {
    first_outbound_at: daysAgo(10),
    last_inbound_at: daysAgo(20),
    last_outbound_at: daysAgo(1),
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  };
  const r = bulkDeriveAction(quietAfterACappedBurst, 0, null, "engaged", "fast");
  assertEquals(r.next_action_key, null);
  assertEquals(r.needs_action, false);

  // …and once it DOES have something to say, that verdict is a real one, so
  // letting it through (the guard's `!actionResult.needs_action` condition)
  // never hides a customer.
  const withAFreshReply = {
    ...quietAfterACappedBurst,
    last_inbound_at: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
  };
  assertEquals(bulkDeriveAction(withAFreshReply, 0, null, "engaged", "fast").next_action_key, "reply_now");
});


// ── rate_limited promises the latest expiry of every tripped cap ───

Deno.test("both caps blown → the 30-day date, not the 7-day one", () => {
  // Eight sends in a week trips both. Returning on the first cap promised
  // availability at last_outbound + 7d, when the lead is still barred.
  const lastOut = daysAgo(1);
  const r = derive(
    metrics({ first_outbound_at: daysAgo(30), last_inbound_at: daysAgo(20), last_outbound_at: lastOut }),
    {
      out7d: S.guardrails.max_emails_per_lead_per_7d,
      out30d: S.guardrails.max_emails_per_lead_per_30d,
    },
  );
  assertEquals(r.next_action_key, "rate_limited");
  assertEquals(
    new Date(r.eligible_at!).getTime(),
    new Date(lastOut).getTime() + 30 * DAY,
  );
});

Deno.test("only the 7-day cap blown → the 7-day date", () => {
  const lastOut = daysAgo(1);
  const r = derive(
    metrics({ first_outbound_at: daysAgo(30), last_inbound_at: daysAgo(20), last_outbound_at: lastOut }),
    { out7d: S.guardrails.max_emails_per_lead_per_7d },
  );
  assertEquals(new Date(r.eligible_at!).getTime(), new Date(lastOut).getTime() + 7 * DAY);
});


// ── The deferral set is shared by BOTH copies of the rule ──────────

Deno.test("gmail-bulk-sync's rule defers to the same specialised waits", () => {
  const at = (days: number, over: Record<string, unknown> = {}) => ({
    first_outbound_at: daysAgo(60),
    last_inbound_at: daysAgo(30),
    last_outbound_at: daysAgo(days),
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
    ...over,
  });
  // post_meeting waits 7 days for its own key, in the sweep as in the shared rule.
  assertEquals(bulkDeriveAction(at(4), 0, null, "post_meeting", "fast").next_action_key, null);
  assertEquals(bulkDeriveAction(at(8), 0, null, "post_meeting", "fast").next_action_key, "followup_due");
  // closing waits 3.
  assertEquals(bulkDeriveAction(at(2), 0, null, "closing", "fast").next_action_key, null);
  // a mid-cadence nurture lead belongs to its campaign.
  assertEquals(
    bulkDeriveAction(at(4, { nurture_outbound_count: 1, last_nurture_outbound_at: daysAgo(4) }),
      0, "weekly", "engaged", "fast").next_action_key,
    null,
  );
  // …and an ordinary engaged lead still surfaces.
  assertEquals(bulkDeriveAction(at(4), 0, null, "engaged", "fast").next_action_key, "followup_due");
});

Deno.test("a volume cap does not claim a lead whose specialised wait is pending", () => {
  const r = derive(
    metrics({ first_outbound_at: daysAgo(60), last_inbound_at: daysAgo(30), last_outbound_at: daysAgo(4) }),
    { stage: "post_meeting", out7d: S.guardrails.max_emails_per_lead_per_7d },
  );
  assertEquals(r.next_action_key, null);
});
