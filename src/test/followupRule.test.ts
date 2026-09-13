// ============================================================
// Unit Q1 — the follow-up rule.
//
// Three layers:
//
//   • BEHAVIOURAL against the REAL `deriveAction`. syncEngine.ts can't be
//     imported through `@shared/*` (it reads `Deno.env` in getCorsHeaders, and
//     `src/test/sharedPurity.test.ts` rightly forbids that in anything the
//     browser bundle pulls in), so this spec loads it by absolute path at
//     runtime instead. Test-only: nothing here ships, and the purity guard's
//     contract — "no impure module reaches the bundle" — is untouched.
//   • BEHAVIOURAL against the pure `@shared/followupRule` and against the
//     automation card's two extracted decision helpers.
//   • SOURCE-TEXT guards for the wiring that has no return value to assert on.
//
// The same scenarios run under Deno end-to-end in
// `supabase/functions/_shared/followupDue.test.ts` (npm run test:edge).
// ============================================================
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_FOLLOWUP_WAIT_DAYS,
  mustClearEligibleAt,
  deriveFollowupDue,
  followupWaitDays,
  FOLLOWUP_DUE_KEY,
  PROMPT_ONLY_KEYS,
  NON_QUEUE_ACTION_KEYS,
  OUTBOUND_SEND_KEYS,
  QUEUE_ACTION_KEYS,
  rateLimitedAction,
  RATE_LIMITED_KEY,
} from "@shared/followupRule";
import { belongsInReactiveTabs, chipForLead, urgencyOf } from "@/lib/queueQueries";
import { getActionType } from "@/lib/dashboardUtils";
import {
  automationCardState,
  buildResumeUpdateFields,
} from "@/components/lead/AutomationPreviewCard";
import { deriveAction as bulkDeriveAction } from "@shared/bulkSyncAction";
import { getMotionIntervals } from "@/lib/cadenceSettingsTypes";
import {
  buildAutomationEnableFields,
  getStepLabels,
  nextCadenceStepKey,
} from "@/lib/leadAutomationActions";

const ROOT = path.resolve(__dirname, "../..");
const SYNC_ENGINE = "supabase/functions/_shared/syncEngine.ts";
const syncEngineSrc = readFileSync(path.join(ROOT, SYNC_ENGINE), "utf8");

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

// ── The real deriveAction, loaded in Node ──────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let engine: any;

beforeAll(async () => {
  engine = await import(/* @vite-ignore */ path.join(ROOT, SYNC_ENGINE));
});

type Metrics = {
  first_outbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  meeting_summary_count: number;
  nurture_outbound_count: number;
  last_nurture_outbound_at: string | null;
};

function metrics(partial: Partial<Metrics>): Metrics {
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
  m: Metrics,
  opts: { stage?: string; strategy?: string; out7d?: number; out30d?: number; mode?: any } = {},
) {
  const S = engine.DEFAULT_CADENCE_SETTINGS;
  const strategy = opts.strategy ?? "fast";
  return engine.deriveAction(
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

// The clock: these scenarios are written relative to NOW, so freeze it.
const withFrozenClock = <T>(fn: () => T): T => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
};

describe("deriveAction — the six-week hole (real function)", () => {
  it("surfaces a warm lead who replied two months ago and was emailed 4 days ago", () => {
    // On origin/main this lead returns {needs_action: false, key: null} — it had
    // no follow-up rule at all and waited 45 days for `reengage`.
    const r = withFrozenClock(() => derive(metrics({
      first_outbound_at: daysAgo(70),
      last_inbound_at: daysAgo(60),
      last_outbound_at: daysAgo(4),
    })));
    expect(r.next_action_key).toBe(FOLLOWUP_DUE_KEY);
    expect(r.needs_action).toBe(true);
    expect(r.action_reason_code).toBe("FOLLOWUP_DUE");
  });

  it("a fresh inbound still wins — reply_now, never followup_due", () => {
    const r = withFrozenClock(() => derive(metrics({
      first_outbound_at: daysAgo(70),
      last_outbound_at: daysAgo(4),
      last_inbound_at: hoursAgo(6),
    })));
    expect(r.next_action_key).toBe("reply_now");
  });

  it("nurture waits 5 days where fast waits 3", () => {
    const m = metrics({
      first_outbound_at: daysAgo(70),
      last_inbound_at: daysAgo(60),
      last_outbound_at: daysAgo(4),
    });
    withFrozenClock(() => {
      expect(derive(m, { strategy: "fast" }).next_action_key).toBe(FOLLOWUP_DUE_KEY);
      expect(derive(m, { strategy: "nurture" }).next_action_key).toBeNull();
    });
  });

  it("keeps the existing keys where they already fired", () => {
    withFrozenClock(() => {
      // Closing stage — 3-day rule, its own key.
      expect(derive(
        metrics({ first_outbound_at: daysAgo(20), last_inbound_at: daysAgo(10), last_outbound_at: daysAgo(4) }),
        { stage: "closing" },
      ).next_action_key).toBe("closing_followup");
      // Cold cadence — send_pre_N, not the generic prompt.
      expect(derive(
        metrics({ first_outbound_at: daysAgo(4), last_outbound_at: daysAgo(4) }),
        { stage: "contacted" },
      ).next_action_key).toMatch(/^send_pre_/);
      // Post-meeting — 7-day rule, its own key.
      expect(derive(
        metrics({
          first_outbound_at: daysAgo(30), last_inbound_at: daysAgo(20),
          last_outbound_at: daysAgo(9), meeting_summary_count: 1,
        }),
        { stage: "post_meeting" },
      ).next_action_key).toBe("post_meeting_followup");
    });
  });
});

describe("deriveAction — a just-sent email must not bounce back into the Queue", () => {
  const justSent = metrics({
    first_outbound_at: daysAgo(30),
    last_inbound_at: daysAgo(20),
    last_outbound_at: minutesAgo(10),
  });

  it("stays silent 10 minutes after a send (16-hour gap guardrail)", () => {
    // postSendDeriveAction runs seconds after every manual send. If the
    // short-gap guardrails surfaced, a rep sending 30 emails a day would
    // accumulate 30 no-op cards and the Queue would never empty.
    const r = withFrozenClock(() => derive(justSent));
    expect(r.next_action_key).toBeNull();
    expect(r.needs_action).toBe(false);
  });

  it("only the multi-day volume caps become visible", () => {
    const r = withFrozenClock(() => derive(
      metrics({ first_outbound_at: daysAgo(30), last_inbound_at: daysAgo(20), last_outbound_at: daysAgo(1) }),
      { out7d: engine.DEFAULT_CADENCE_SETTINGS.guardrails.max_emails_per_lead_per_7d },
    ));
    expect(r.next_action_key).toBe(RATE_LIMITED_KEY);
    expect(r.needs_action).toBe(true);
    expect(new Date(r.eligible_at).getTime()).toBeGreaterThan(NOW);
  });
});

describe("deriveAction — a fresh reply is never buried under rate_limited", () => {
  it("goes quiet instead of showing a Follow up card over an hour-old inbound", () => {
    // Inbound 1h ago is still inside fast mode's 4h reply_pending window, so
    // branch A hasn't fired yet. Showing `rate_limited` here would render a
    // "Follow up — sent 4d ago" card that hides the customer's reply.
    const r = withFrozenClock(() => derive(
      metrics({ first_outbound_at: daysAgo(30), last_outbound_at: daysAgo(4), last_inbound_at: hoursAgo(1) }),
      { out7d: engine.DEFAULT_CADENCE_SETTINGS.guardrails.max_emails_per_lead_per_7d },
    ));
    expect(r.next_action_key).not.toBe(RATE_LIMITED_KEY);
    expect(r.next_action_key).toBeNull();
  });

  it("still shows the cap when nobody is waiting on us", () => {
    const r = withFrozenClock(() => derive(
      metrics({ first_outbound_at: daysAgo(30), last_outbound_at: daysAgo(1), last_inbound_at: daysAgo(20) }),
      { out7d: engine.DEFAULT_CADENCE_SETTINGS.guardrails.max_emails_per_lead_per_7d },
    ));
    expect(r.next_action_key).toBe(RATE_LIMITED_KEY);
  });
});

describe("buildLeadUpdate — never a send trigger, never a lost cadence anchor", () => {
  const m = metrics({
    first_outbound_at: daysAgo(30),
    last_inbound_at: daysAgo(20),
    last_outbound_at: daysAgo(4),
  });

  it("persists followup_due with no eligible_at, even for an enrolled lead", () => {
    // automation-executor selects on needs_action + eligible_at + consent and
    // ignores the key, so a prompt key with a date would be an auto-send.
    const update = withFrozenClock(() =>
      engine.buildLeadUpdate("engaged", m, derive(m), null, null, "reactive"));
    expect(update.next_action_key).toBe(FOLLOWUP_DUE_KEY);
    expect(update.needs_action).toBe(true);
    expect(update.eligible_at).toBeNull();
  });

  it("leaves a live cadence anchor alone rather than overwriting it with a prompt", () => {
    const armed = {
      needs_action: true,
      eligible_at: new Date(NOW + 2 * 86_400_000).toISOString(),
      motion: "outbound_prospecting",
      nurture_status: "",
      ooo_until: null,
    };
    const update = withFrozenClock(() =>
      engine.buildLeadUpdate("engaged", m, derive(m), null, armed, "reactive"));
    expect(update.next_action_key).toBeNull();
    expect(update.eligible_at).toBe(armed.eligible_at);
  });
});

// ── The pure rule ──────────────────────────────────────────────────

describe("deriveFollowupDue — my unanswered message after N days", () => {
  it("fires for a lead who replied long ago and went quiet", () => {
    const result = deriveFollowupDue(
      { last_inbound_at: daysAgo(60), last_outbound_at: daysAgo(4) },
      3,
      NOW,
    );
    expect(result?.next_action_key).toBe(FOLLOWUP_DUE_KEY);
    expect(result?.next_action_label).toBe("Follow up (no reply in 3 days)");
  });

  it("fires for a lead who never replied at all", () => {
    expect(deriveFollowupDue({ last_inbound_at: null, last_outbound_at: daysAgo(4) }, 3, NOW)
      ?.next_action_key).toBe(FOLLOWUP_DUE_KEY);
  });

  it("stays quiet while the wait window is still open", () => {
    expect(deriveFollowupDue({ last_inbound_at: null, last_outbound_at: daysAgo(2) }, 3, NOW))
      .toBeNull();
  });

  it("never fires on a fresh inbound", () => {
    expect(deriveFollowupDue({ last_inbound_at: daysAgo(1), last_outbound_at: daysAgo(4) }, 3, NOW))
      .toBeNull();
    const t = daysAgo(4);
    expect(deriveFollowupDue({ last_inbound_at: t, last_outbound_at: t }, 3, NOW)).toBeNull();
  });

  it("stays quiet for a lead we have never emailed", () => {
    expect(deriveFollowupDue({ last_inbound_at: daysAgo(10), last_outbound_at: null }, 3, NOW))
      .toBeNull();
  });

  it("dates eligible_at at the due moment (calendar days, not business days)", () => {
    expect(deriveFollowupDue({ last_inbound_at: null, last_outbound_at: daysAgo(10) }, 3, NOW)
      ?.eligible_at).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
  });
});

describe("followupWaitDays — 3 fast, 5 nurture (the only values in play today)", () => {
  it("defaults to 3 days for fast motion", () => {
    expect(followupWaitDays("fast", undefined)).toBe(DEFAULT_FOLLOWUP_WAIT_DAYS.fast);
    expect(followupWaitDays("fast", {})).toBe(3);
  });

  it("defaults to 5 days for nurture", () => {
    expect(followupWaitDays("nurture", undefined)).toBe(DEFAULT_FOLLOWUP_WAIT_DAYS.nurture);
    expect(followupWaitDays("nurture", { followup_wait_days: null })).toBe(5);
  });

  it("honours a stored modes.<strategy>.followup_wait_days if one is ever present", () => {
    // NOT reachable from the settings UI today — the client CadenceSettingsV1
    // has `motions`, not `modes`, and no such field. Pinned because every read
    // path (send, sync, cron) must agree the day it becomes settable.
    expect(followupWaitDays("fast", { followup_wait_days: 7 })).toBe(7);
    expect(followupWaitDays("nurture", { followup_wait_days: 1 })).toBe(1);
  });

  it("floors at one day so the rule can't collide with the short-gap guardrails", () => {
    expect(followupWaitDays("fast", { followup_wait_days: 0 })).toBe(3);
    expect(followupWaitDays("fast", { followup_wait_days: -2 })).toBe(3);
    expect(followupWaitDays("fast", { followup_wait_days: Number.NaN })).toBe(3);
  });

  it("ships the same defaults in DEFAULT_CADENCE_SETTINGS (the override surface)", () => {
    // The setting lives in workspace_profiles.cadence_settings.modes.<mode>
    // (existing JSONB, deep-merged) — no new column.
    expect(engine.DEFAULT_CADENCE_SETTINGS.modes.fast.followup_wait_days).toBe(3);
    expect(engine.DEFAULT_CADENCE_SETTINGS.modes.nurture.followup_wait_days).toBe(5);
  });
});

// ── The two new keys are prompts, never sends ──────────────────────

describe("followup_due / rate_limited are human prompts, not send triggers", () => {
  it("keeps them out of the outbound-send key set", () => {
    expect(OUTBOUND_SEND_KEYS.has(FOLLOWUP_DUE_KEY)).toBe(false);
    expect(OUTBOUND_SEND_KEYS.has(RATE_LIMITED_KEY)).toBe(false);
    expect(OUTBOUND_SEND_KEYS.has("reply_now")).toBe(false);
    // Guard is not vacuous — the real send keys are still in there.
    expect(OUTBOUND_SEND_KEYS.has("send_pre_2")).toBe(true);
  });

  it("marks both as prompt-only", () => {
    expect([...PROMPT_ONLY_KEYS].sort()).toEqual([FOLLOWUP_DUE_KEY, RATE_LIMITED_KEY].sort());
  });

  it("blanks eligible_at before persisting them (see the invariant suite below)", () => {
    expect(syncEngineSrc).toMatch(
      /mustClearEligibleAt\(leadUpdate\.next_action_key\)[\s\S]{0,60}leadUpdate\.eligible_at = null;/,
    );
  });
});

// ── Guardrail suppression, narrowly ────────────────────────────────

describe("rate_limited — honest about what is actually paused", () => {
  const availableAt = NOW + 2 * 86_400_000;

  it("stays in the queue and names the date the AUTOMATIC send resumes", () => {
    const result = rateLimitedAction(availableAt, "UTC");
    expect(result.needs_action).toBe(true);
    expect(result.next_action_key).toBe(RATE_LIMITED_KEY);
    expect(result.action_reason_code).toBe("RATE_LIMITED");
    expect(new Date(result.eligible_at).getTime()).toBeGreaterThan(NOW);
    // The rep can still write to this lead right now — the label must not
    // read as "you may not act until Sep 10".
    expect(result.next_action_label).toBe("Follow up anytime — auto-send paused until Sep 10");
  });

  it("renders the date in the workspace timezone, never throwing on a bad one", () => {
    expect(rateLimitedAction(availableAt, "Asia/Tokyo").next_action_label)
      .toContain("Sep 10");
    expect(rateLimitedAction(availableAt, "Not/AZone").next_action_label)
      .toContain("Sep 10");
    expect(rateLimitedAction(availableAt, null).next_action_label).toContain("Sep 10");
  });

  it("is emitted for the volume caps only — the short-gap rules stay silent", () => {
    const guardrailBlock = syncEngineSrc.slice(
      syncEngineSrc.indexOf("\n  // GUARDRAILS\n"),
      syncEngineSrc.indexOf("\n  // STOP RULES\n"),
    );
    expect(guardrailBlock.length).toBeGreaterThan(0);
    // Exactly two capped() call sites: the 7-day and 30-day caps.
    expect(guardrailBlock.match(/return capped\(/g)?.length).toBe(2);
    // …and no rate-limit surfacing anywhere near the min-gap / same-day rules.
    expect(guardrailBlock).toContain("min_gap_hours_between_emails");
    expect(guardrailBlock.match(/rateLimitedAction\(/g)?.length).toBe(1);
  });
});

// ── Wiring inside deriveAction ─────────────────────────────────────

describe("deriveAction wiring", () => {
  it("evaluates the follow-up rule after REPLY PENDING and before the guardrails", () => {
    const replyPending = syncEngineSrc.indexOf("// A) REPLY PENDING");
    const followup = syncEngineSrc.indexOf("const followupDue = deriveFollowupDue(");
    const guardrails = syncEngineSrc.indexOf("\n  // GUARDRAILS\n");
    expect(replyPending).toBeGreaterThan(-1);
    expect(followup).toBeGreaterThan(replyPending);
    expect(guardrails).toBeGreaterThan(followup);
  });

  it("falls back to followup_due instead of dropping the lead entirely", () => {
    expect(syncEngineSrc).toContain(
      "return followupDue ?? { needs_action: false, next_action_key: null",
    );
  });
});

// ── Resume can never arm a Queue prompt ────────────────────────────

describe("automation card — a Queue prompt is not a paused sequence", () => {
  const base = { needs_action: true, eligible_at: null, automation_mode: null };

  it("reads a followup_due lead as 'automation off', not 'user paused'", () => {
    for (const key of [FOLLOWUP_DUE_KEY, RATE_LIMITED_KEY]) {
      const state = automationCardState({ ...base, next_action_key: key });
      expect(state.hasAutomationEnabled).toBe(false);
      expect(state.userPaused).toBe(false);
      expect(state.automationEverEnabled).toBe(false);
    }
  });

  it("still reads a real paused cadence as paused", () => {
    const state = automationCardState({ ...base, next_action_key: "send_pre_2" });
    expect(state.userPaused).toBe(true);
  });

  it("still reads an armed cadence as running", () => {
    const state = automationCardState({
      needs_action: true,
      next_action_key: "send_pre_2",
      eligible_at: new Date(NOW + 86_400_000).toISOString(),
      automation_mode: "reactive",
    });
    expect(state.hasAutomationEnabled).toBe(true);
    expect(state.userPaused).toBe(false);
  });

  it("treats an enrolled lead carrying a prompt key as paused (Resume is safe now)", () => {
    const state = automationCardState({
      ...base, next_action_key: FOLLOWUP_DUE_KEY, automation_mode: "reactive",
    });
    expect(state.hasAutomationEnabled).toBe(false);
    expect(state.userPaused).toBe(true);
  });
});

describe("Enable Automation never arms a prompt key", () => {
  // The first turn-on path, reached from AutomationPreviewCard's "Enable" and
  // from AutomationToggleCard. `automationCardState` now routes a never-enrolled
  // followup_due lead to exactly this button, so it has to be safe.
  const enable = (lead: Record<string, unknown>) =>
    buildAutomationEnableFields(lead as never) as Record<string, unknown>;

  it.each([FOLLOWUP_DUE_KEY, RATE_LIMITED_KEY])(
    "refuses to carry %s into an armed eligible_at",
    (key) => {
      const fields = enable({
        next_action_key: key,
        last_outbound_at: daysAgo(4),
        motion: "outbound_prospecting",
      });
      // The forbidden row shape the executor would send on.
      expect(
        PROMPT_ONLY_KEYS.has(fields.next_action_key as string) && fields.eligible_at != null,
      ).toBe(false);
      expect(fields.next_action_key).toBe("send_pre_2");
      // And the card no longer mislabels a step-2 arm as "Step 1 of 4".
      expect(fields.next_action_label).toBe("Step 2 of 4");
      expect(fields.automation_mode).toBe("full_auto");
    },
  );

  it("still carries a genuine cadence key forward unchanged", () => {
    expect(enable({
      next_action_key: "send_pre_3", last_outbound_at: daysAgo(4), motion: "outbound_prospecting",
    }).next_action_key).toBe("send_pre_3");
  });

  it("starts at step 1 for a lead that was never emailed", () => {
    expect(enable({
      next_action_key: FOLLOWUP_DUE_KEY, last_outbound_at: null, motion: "outbound_prospecting",
    }).next_action_key).toBe("send_pre_1");
  });

  it("nurture leads are unaffected", () => {
    expect(enable({
      next_action_key: RATE_LIMITED_KEY, motion: "nurture", nurture_outbound_count: 1,
    }).next_action_key).toBe("nurture_2");
  });
});

describe("nextCadenceStepKey — the single place the guard lives", () => {
  it("is what both builders use", () => {
    const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
    for (const rel of [
      "src/lib/leadAutomationActions.ts",
      "src/components/lead/AutomationPreviewCard.tsx",
    ]) {
      expect(src(rel)).toContain("nextCadenceStepKey(");
      // No second, unguarded copy of the carry-forward expression.
      expect(src(rel)).not.toMatch(/lead\.next_action_key \|\| "send_pre_2"/);
    }
  });

  it.each([FOLLOWUP_DUE_KEY, RATE_LIMITED_KEY])("never returns %s", (key) => {
    expect(nextCadenceStepKey({ next_action_key: key, last_outbound_at: daysAgo(4) }))
      .toBe("send_pre_2");
    expect(nextCadenceStepKey({ next_action_key: key, last_outbound_at: null }))
      .toBe("send_pre_1");
  });
});

describe("automation card — Resume never arms a prompt key", () => {
  const opts = {
    intervals: getMotionIntervals("outbound_prospecting"),
    stepLabels: getStepLabels("outbound_prospecting"),
    now: new Date(NOW),
  };

  it.each([FOLLOWUP_DUE_KEY, RATE_LIMITED_KEY])(
    "refuses to carry %s into an armed eligible_at",
    (key) => {
      const fields = buildResumeUpdateFields(
        { next_action_key: key, last_outbound_at: daysAgo(4), motion: "outbound_prospecting" },
        opts,
      );
      // The forbidden row shape: prompt key + a date the executor will fire on.
      expect(
        PROMPT_ONLY_KEYS.has(fields.next_action_key as string) && fields.eligible_at != null,
      ).toBe(false);
      expect(fields.next_action_key).toBe("send_pre_2");
      // A real step number, not NaN → a real cadence gap.
      expect(typeof fields.eligible_at).toBe("string");
    },
  );

  it("still carries a genuine cadence key forward unchanged", () => {
    const fields = buildResumeUpdateFields(
      { next_action_key: "send_pre_3", last_outbound_at: daysAgo(4), motion: "outbound_prospecting" },
      opts,
    );
    expect(fields.next_action_key).toBe("send_pre_3");
  });

  it("starts at step 1 for a lead that was never emailed", () => {
    const fields = buildResumeUpdateFields(
      { next_action_key: FOLLOWUP_DUE_KEY, last_outbound_at: null, motion: "outbound_prospecting" },
      opts,
    );
    expect(fields.next_action_key).toBe("send_pre_1");
  });

  it("nurture leads are unaffected", () => {
    const fields = buildResumeUpdateFields(
      { next_action_key: FOLLOWUP_DUE_KEY, motion: "nurture", nurture_outbound_count: 2 },
      opts,
    );
    expect(fields.next_action_key).toBe("nurture_3");
  });
});

// ── Every emittable key is registered everywhere it is consumed ────

describe("action-key registry", () => {
  // SCOPE: the keys `_shared/syncEngine.ts` itself can emit, plus
  // `ooo_return_followup`. Other writers (nurture_N from the automation
  // dialogs, wait_reply from the sync hooks, whatsapp_failed, campaign step
  // keys) are unregistered TODAY and pre-date this unit — they are tracked as
  // follow-up work, not covered here.
  const emitted = new Set<string>();
  for (const m of syncEngineSrc.matchAll(/next_action_key: ["`]([A-Za-z0-9_${}+ ]+)["`]/g)) {
    emitted.add(m[1].replace(/\$\{[^}]*\}/g, "N").replace(/_N$/, "_1"));
  }

  it("finds the keys (guard is not vacuous)", () => {
    expect(emitted.size).toBeGreaterThan(5);
  });

  it("has no key syncEngine can emit that the registry doesn't know", () => {
    const known = new Set([
      ...QUEUE_ACTION_KEYS,
      ...NON_QUEUE_ACTION_KEYS,
      "send_pre_1", "send_pre_2", "send_pre_3", "send_pre_4",
    ]);
    expect([...emitted].filter((k) => !known.has(k))).toEqual([]);
  });

  it.each(QUEUE_ACTION_KEYS)("%s has a Queue urgency, a chip and an action type", (key) => {
    // An unregistered key sorts to 100 — indistinguishable from "unknown",
    // which is the blank-card failure mode.
    expect(urgencyOf(key)).toBeLessThan(100);
    const bucket = chipForLead({ next_action_key: key, action_resurfaced_at: null });
    expect(bucket).toBe(key === "reply_now" ? "replied" : "followup_due");
    // "view" is getActionType's fallback, so only genuinely read-only keys may
    // land there. `reengage` is a pre-existing gap, listed so it stays visible.
    const viewOnly = new Set([
      "switch_to_nurture", "ooo_return_followup", "reengage", RATE_LIMITED_KEY,
    ]);
    if (viewOnly.has(key)) expect(getActionType(key)).toBe("view");
    else expect(getActionType(key)).not.toBe("view");
  });

  it("routes the two new keys to Follow up, never Replied", () => {
    for (const key of [FOLLOWUP_DUE_KEY, RATE_LIMITED_KEY]) {
      expect(chipForLead({ next_action_key: key, action_resurfaced_at: null }))
        .toBe("followup_due");
    }
  });
});


describe("campaign-origin leads reach the Follow up tab", () => {
  // The flow: a campaign prospect replies, the enrolment is stopped, the rep
  // answers, days pass. Outbound is now NEWER than inbound and
  // `endColdEnrollment` leaves `campaign_id` set, so the old filter dropped the
  // lead from the reactive tabs — and the stopped campaign had nothing to show
  // for it either. The six-week hole, surviving for campaign-origin leads.
  const afterTheRepAnswered = {
    campaign_id: "camp-1",
    last_inbound_at: daysAgo(9),
    last_outbound_at: daysAgo(4),
  };

  it("keeps a followup_due lead visible once the enrollment has ended", () => {
    expect(belongsInReactiveTabs(
      { ...afterTheRepAnswered, next_action_key: FOLLOWUP_DUE_KEY },
      { hasLiveEnrollment: false },
    )).toBe(true);
  });

  it("leaves a followup_due lead in Outreach while its enrollment is still live", () => {
    // The scheduled sweep emits followup_due for never-replied campaign leads
    // too. With a touch still queued, Outreach owns the lead — showing it in
    // Follow up would double-count the same cadence.
    expect(belongsInReactiveTabs(
      { campaign_id: "camp-1", next_action_key: FOLLOWUP_DUE_KEY,
        last_inbound_at: null, last_outbound_at: daysAgo(4) },
      { hasLiveEnrollment: true },
    )).toBe(false);
    // …and a never-replied lead whose enrollment ended does come through.
    expect(belongsInReactiveTabs(
      { campaign_id: "camp-1", next_action_key: FOLLOWUP_DUE_KEY,
        last_inbound_at: null, last_outbound_at: daysAgo(4) },
      { hasLiveEnrollment: false },
    )).toBe(true);
  });

  it("does NOT admit a never-replied campaign lead just because it is rate_limited", () => {
    // An ACTIVE campaign earns `rate_limited` from its own outbound volume cap,
    // with no reply from the prospect. Letting that through would flood the
    // reactive list with leads that have never engaged.
    expect(belongsInReactiveTabs({
      campaign_id: "camp-1", next_action_key: RATE_LIMITED_KEY,
      last_inbound_at: null, last_outbound_at: daysAgo(1),
    })).toBe(false);
  });

  it("still admits a rate_limited lead that HAS engaged", () => {
    expect(belongsInReactiveTabs({
      campaign_id: "camp-1", next_action_key: RATE_LIMITED_KEY,
      last_inbound_at: daysAgo(1), last_outbound_at: daysAgo(4),
    })).toBe(true);
  });

  it("still keeps purely cold campaign leads in the Outreach tab", () => {
    expect(belongsInReactiveTabs({
      campaign_id: "camp-1", next_action_key: "send_pre_2",
      last_inbound_at: null, last_outbound_at: daysAgo(4),
    })).toBe(false);
  });

  it("still routes an unanswered reply and non-campaign leads through", () => {
    expect(belongsInReactiveTabs({
      campaign_id: "camp-1", next_action_key: "reply_now",
      last_inbound_at: daysAgo(1), last_outbound_at: daysAgo(4),
    })).toBe(true);
    expect(belongsInReactiveTabs({
      campaign_id: null, next_action_key: "send_pre_2",
      last_inbound_at: null, last_outbound_at: daysAgo(4),
    })).toBe(true);
  });
});


// ── The post-send recompute must not downgrade the AI's stage ──────

describe("recomputeLeadAction — preserveStage", () => {
  // `_shared/postSendDeriveAction.ts` takes its Supabase client as a parameter,
  // so a recording stub exercises the REAL function end to end without a DB.
  // Every builder method returns the same thenable; awaiting it yields the
  // result configured for that table.
  function stubClient(rows: Record<string, unknown>) {
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const from = (table: string) => {
      let updating: Record<string, unknown> | null = null;
      const builder: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            const result = updating
              ? { data: null, error: null }
              : { data: (rows as any)[table] ?? null, error: null };
            return (res: any, rej: any) => Promise.resolve(result).then(res, rej);
          }
          return (...args: any[]) => {
            if (prop === "update") {
              updating = args[0];
              updates.push({ table, payload: args[0] });
            }
            return builder;
          };
        },
      });
      return builder;
    };
    return { client: { from } as never, updates };
  }

  /** A lead the AI has just promoted to `closing` on a manual send. */
  const rows = () => ({
    leads: {
      id: "lead-1",
      stage: "closing",
      strategy: "fast",
      owner_user_id: null,
      has_future_meeting: false,
      action_dismissed_at: null,
      motion: "outbound_prospecting",
      workspace_id: "ws-1",
      needs_action: false,
      eligible_at: null,
      nurture_status: "",
      ooo_until: null,
      automation_mode: null,
    },
    interactions: [
      { type: "email", direction: "outbound", occurred_at: daysAgo(70), body_text: "hi" },
      { type: "email", direction: "inbound", occurred_at: daysAgo(60), body_text: "interested" },
      { type: "email", direction: "outbound", occurred_at: daysAgo(4), body_text: "circling back" },
    ],
    meeting_packs: [],
    drafts: [],
    workspace_profiles: null,
  });

  it("leaves stage out of the write when the caller asks it to", async () => {
    const { client, updates } = stubClient(rows());
    const { recomputeLeadAction } = await import(
      /* @vite-ignore */ path.join(ROOT, "supabase/functions/_shared/postSendDeriveAction.ts")
    );
    await recomputeLeadAction(client, "lead-1", "[test]", true);
    const write = updates.find((u) => u.table === "leads");
    expect(write).toBeDefined();
    expect("stage" in write!.payload).toBe(false);
    // It still does its real job: the follow-up is derived and persisted.
    expect(write!.payload.next_action_key).toBe(FOLLOWUP_DUE_KEY);
    expect(write!.payload.eligible_at).toBeNull();
  });

  it("would otherwise downgrade `closing` to `engaged` (the bug)", async () => {
    const { client, updates } = stubClient(rows());
    const { recomputeLeadAction } = await import(
      /* @vite-ignore */ path.join(ROOT, "supabase/functions/_shared/postSendDeriveAction.ts")
    );
    await recomputeLeadAction(client, "lead-1", "[test]");
    const write = updates.find((u) => u.table === "leads");
    // deriveStage keeps only the closed stages, so without preserveStage the
    // AI's `closing` is silently overwritten seconds after the send.
    expect(write!.payload.stage).toBe("engaged");
  });

  it("both email send paths ask for it", () => {
    for (const rel of [
      "supabase/functions/gmail-send/index.ts",
      "supabase/functions/outlook-send/index.ts",
    ]) {
      expect(readFileSync(path.join(ROOT, rel), "utf8")).toMatch(
        /postSendDeriveAction\([\s\S]{0,400}preserveStage: true/,
      );
    }
  });
});


// ── Closed deals are done ──────────────────────────────────────────

describe("deriveAction — a closed deal is never chased", () => {
  const quietSinceOurLastWord = metrics({
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(30),
    last_outbound_at: daysAgo(10),
  });

  it.each(["closed_won", "closed_lost"])("stays silent for %s", (stage) => {
    const r = withFrozenClock(() => derive(quietSinceOurLastWord, { stage }));
    expect(r.needs_action).toBe(false);
    expect(r.next_action_key).toBeNull();
  });

  it("still surfaces a customer who writes after the deal closed", () => {
    // A real person waiting on a reply outranks the closed stage.
    const r = withFrozenClock(() => derive(
      metrics({ first_outbound_at: daysAgo(70), last_outbound_at: daysAgo(10), last_inbound_at: hoursAgo(6) }),
      { stage: "closed_won" },
    ));
    expect(r.next_action_key).toBe("reply_now");
  });

  it("an open deal in the same shape still gets followup_due (guard is not vacuous)", () => {
    expect(withFrozenClock(() => derive(quietSinceOurLastWord, { stage: "engaged" })).next_action_key)
      .toBe(FOLLOWUP_DUE_KEY);
  });
});

// ── The scheduled Gmail path ───────────────────────────────────────
//
// `gmail-bulk-sync` has its OWN private deriveAction (a simplified copy) and it
// is the only Gmail path that runs on a cron. Before this change it returned
// null for the warm-quiet lead and the sweep WROTE that null over the
// followup_due the shared rule had produced — so the six-week hole was closed
// for nobody on a schedule.

describe("gmail-bulk-sync — the scheduled sweep surfaces the follow-up", () => {
  const warmAndQuiet = {
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(60),   // they replied once, long ago
    last_outbound_at: daysAgo(4),   // we wrote last, four days back
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  };

  it("surfaces a Gmail lead emailed four days ago and quiet since", () => {
    // THE regression: returns {needs_action: false, key: null} on origin/main.
    const r = withFrozenClock(() => bulkDeriveAction(warmAndQuiet, 0, null, "engaged", "fast"));
    expect(r.next_action_key).toBe(FOLLOWUP_DUE_KEY);
    expect(r.needs_action).toBe(true);
  });

  it("honours the nurture wait like the shared rule", () => {
    expect(withFrozenClock(() => bulkDeriveAction(warmAndQuiet, 0, null, "engaged", "nurture"))
      .next_action_key).toBeNull();
  });

  it("never chases a closed deal", () => {
    for (const stage of ["closed_won", "closed_lost"]) {
      expect(withFrozenClock(() => bulkDeriveAction(warmAndQuiet, 0, null, stage, "fast"))
        .next_action_key).toBeNull();
    }
  });

  it("leaves every existing verdict alone", () => {
    const at = (o: Record<string, unknown>) => ({ ...warmAndQuiet, ...o });
    withFrozenClock(() => {
      // Unanswered reply → reply_now (its own 6h window, untouched).
      expect(bulkDeriveAction(at({ last_inbound_at: hoursAgo(8) }), 0, null, "engaged", "fast")
        .next_action_key).toBe("reply_now");
      // Closing stage → closing_followup, not the generic prompt.
      expect(bulkDeriveAction(warmAndQuiet, 0, null, "closing", "fast").next_action_key)
        .toBe("closing_followup");
      // Cold cadence → send_pre_N, on bulk-sync's own hardcoded day numbers.
      expect(bulkDeriveAction(
        at({ last_inbound_at: null, first_outbound_at: daysAgo(8), last_outbound_at: daysAgo(4) }),
        0, null, "contacted", "fast",
      ).next_action_key).toBe("send_pre_3");
      // Post-meeting recap.
      expect(bulkDeriveAction(at({ meeting_summary_count: 1 }), 0, null, "post_meeting", "fast")
        .next_action_key).toBe("generate_post_meeting_recap");
      // Nurture cadence.
      expect(bulkDeriveAction(
        at({ nurture_outbound_count: 1, last_nurture_outbound_at: daysAgo(20) }),
        0, "weekly", "engaged", "fast",
      ).next_action_key).toBe("send_nurture_2");
    });
  });

  it("still writes no eligible_at from the scheduled path", () => {
    const src = readFileSync(path.join(ROOT, "supabase/functions/gmail-bulk-sync/index.ts"), "utf8");
    // The consent gate forbidding scheduled sends must still be in place.
    expect(src).toContain("CONSENT GATE (defensive)");
    // And the four action-overwrite guards are untouched.
    for (const guard of ["isActiveNurture", "isActiveOOO", "isAutomationScheduled", "hasRecentAutoSend"]) {
      expect(src).toContain(guard);
    }
  });
});

// ── A failed interaction insert must not trigger a stale recompute ──

describe("send paths guard the recompute on the interaction insert", () => {
  it.each([
    "supabase/functions/gmail-send/index.ts",
    "supabase/functions/outlook-send/index.ts",
  ])("%s only recomputes when the outbound row landed", (rel) => {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    expect(src).toMatch(/if \(interactionRow\) \{[\s\S]{0,600}postSendDeriveAction\(/);
    // The send itself is never skipped — only the recompute.
    expect(src).toMatch(/skipping follow-up recompute/);
  });
});


// ── THE INVARIANT: a prompt key never sits next to a live eligible_at ──

describe("every writer of a prompt-only key nulls eligible_at", () => {
  it("names the rule in one place", () => {
    expect(mustClearEligibleAt(FOLLOWUP_DUE_KEY)).toBe(true);
    expect(mustClearEligibleAt(RATE_LIMITED_KEY)).toBe(true);
    expect(mustClearEligibleAt("send_pre_2")).toBe(false);
    expect(mustClearEligibleAt(null)).toBe(false);
  });

  it("gmail-bulk-sync's update payload can never leave a stale timestamp", () => {
    // THE BUG: `isAutomationScheduled` only catches a FUTURE eligible_at, so an
    // enrolled lead whose timestamp has already PASSED falls through to the
    // action-overwrite branch — which wrote needs_action + followup_due and left
    // the past timestamp untouched, because this file never put `eligible_at` in
    // its payload at all. That row is exactly automation-executor's candidate
    // shape. Replayed here against the real source of the branch.
    const src = readFileSync(path.join(ROOT, "supabase/functions/gmail-bulk-sync/index.ts"), "utf8");
    const branch = src.slice(
      src.indexOf("// Apply derived action for non-nurture"),
      src.indexOf("// CONSENT GATE (defensive)"),
    );
    expect(branch.length).toBeGreaterThan(0);
    // The key/label/needs_action write and the de-arming write are in the SAME
    // branch, so no row can carry one without the other.
    expect(branch).toContain("updatePayload.next_action_key = actionResult.next_action_key;");
    expect(branch).toMatch(
      /mustClearEligibleAt\(actionResult\.next_action_key\)[\s\S]{0,80}updatePayload\.eligible_at = null;/,
    );
    // And the guard above it is the one that misses past timestamps — pinned so
    // nobody "fixes" this by trusting it.
    expect(src).toMatch(/isAutomationScheduled[\s\S]{0,200}getTime\(\) > Date\.now\(\)/);
  });

  it("the consent gate lets a de-arming null through", () => {
    // If the gate still fired on any `"eligible_at" in payload`, the fix above
    // would be stripped straight back out and logged as a violation.
    const src = readFileSync(path.join(ROOT, "supabase/functions/gmail-bulk-sync/index.ts"), "utf8");
    expect(src).toContain("updatePayload.eligible_at != null &&");
    expect(src).not.toContain('"eligible_at" in updatePayload &&');
  });

  it("buildLeadUpdate uses the same named rule", () => {
    expect(syncEngineSrc).toMatch(
      /mustClearEligibleAt\(leadUpdate\.next_action_key\)[\s\S]{0,60}leadUpdate\.eligible_at = null;/,
    );
  });
});

describe("a stored wait, if present, reaches the scheduled path too", () => {
  const warmAndQuiet = {
    first_outbound_at: daysAgo(70),
    last_inbound_at: daysAgo(60),
    last_outbound_at: daysAgo(4),
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  };

  it("waits longer when a stored setting says so", () => {
    expect(withFrozenClock(() =>
      bulkDeriveAction(warmAndQuiet, 0, null, "engaged", "fast", { followup_wait_days: 10 })
    ).next_action_key).toBeNull();
  });

  it("surfaces sooner when a stored setting says so", () => {
    expect(withFrozenClock(() =>
      bulkDeriveAction(warmAndQuiet, 0, null, "engaged", "nurture", { followup_wait_days: 2 })
    ).next_action_key).toBe(FOLLOWUP_DUE_KEY);
  });

  it("bulk-sync loads the profile once per connection, not once per lead", () => {
    const src = readFileSync(path.join(ROOT, "supabase/functions/gmail-bulk-sync/index.ts"), "utf8");
    // Threaded through as a parameter; the loader is never called inside
    // syncLeadEmails (which runs per lead).
    expect(src).toContain("cadenceModes: CadenceModes | null = null");
    const perLead = src.slice(src.indexOf("async function syncLeadEmails("), src.indexOf("async function resolveWorkspaceIds("));
    expect(perLead).not.toContain("loadCadenceModes(");
    expect((src.match(/await loadCadenceModes\(/g) ?? []).length).toBe(2);
  });
});


// ── The claim matches reality ──────────────────────────────────────

describe("followup_wait_days is not advertised as workspace-configurable", () => {
  it("the client settings schema genuinely has no such field", () => {
    // If this ever fails, the field became settable — go update the docblocks
    // in followupRule/syncEngine/bulkSyncAction that currently say it is not.
    const client = readFileSync(path.join(ROOT, "src/lib/cadenceSettingsTypes.ts"), "utf8");
    expect(client).not.toContain("followup_wait_days");
    expect(client).toContain("motions: {");   // a different shape from `modes`
  });

  it("no docblock calls it a workspace override", () => {
    for (const rel of [
      "supabase/functions/_shared/followupRule.ts",
      "supabase/functions/_shared/syncEngine.ts",
      "supabase/functions/_shared/bulkSyncAction.ts",
    ]) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/Workspace override|workspace can (set|configure|override)/i);
    }
  });
});

// ── The sweep must not erase rate_limited ──────────────────────────

describe("gmail-bulk-sync preserves a verdict it cannot compute", () => {
  const branch = () => {
    const src = readFileSync(path.join(ROOT, "supabase/functions/gmail-bulk-sync/index.ts"), "utf8");
    return src.slice(src.indexOf("  if (isActiveNurture) {"), src.indexOf("// CONSENT GATE (defensive)"));
  };

  it("has no volume-cap inputs, so it can never re-derive rate_limited", () => {
    // The premise of the guard: this rule takes no guardrails and no outbound
    // counts, so `rate_limited` is not in its vocabulary at all.
    const rule = readFileSync(path.join(ROOT, "supabase/functions/_shared/bulkSyncAction.ts"), "utf8");
    expect(rule).not.toContain("rate_limited");
    expect(rule).not.toContain("max_emails_per_lead");
  });

  it("leaves an active rate_limited lead alone when it has nothing to say", () => {
    // A rep reading "auto-send paused until the 18th" must not watch the card
    // blank itself twenty minutes later.
    expect(branch()).toMatch(
      /currentState\?\.next_action_key === RATE_LIMITED_KEY[\s\S]{0,200}!actionResult\.needs_action/,
    );
    // It is a guard branch — it writes nothing, exactly like the nurture/OOO ones.
    const guard = branch().slice(branch().indexOf("RATE_LIMITED_KEY"));
    const body = guard.slice(0, guard.indexOf("} else if (!hasActivity"));
    expect(body).not.toContain("updatePayload.");
  });

  it("still lets a real verdict through — a reply is never hidden behind it", () => {
    // The guard is conditioned on `!actionResult.needs_action`, so reply_now,
    // followup_due, closing_followup … all still overwrite it.
    expect(branch()).toContain("&& !actionResult.needs_action");
    // And the sweep really does produce those verdicts for such a lead.
    const warmWithReply = {
      first_outbound_at: daysAgo(70),
      last_inbound_at: hoursAgo(8),
      last_outbound_at: daysAgo(4),
      meeting_summary_count: 0,
      nurture_outbound_count: 0,
      last_nurture_outbound_at: null,
    };
    expect(withFrozenClock(() => bulkDeriveAction(warmWithReply, 0, null, "engaged", "fast"))
      .next_action_key).toBe("reply_now");
  });

  it("reads next_action_key from the state it already fetches (no new query)", () => {
    const src = readFileSync(path.join(ROOT, "supabase/functions/gmail-bulk-sync/index.ts"), "utf8");
    expect(src).toContain(
      '.select("motion, nurture_status, ooo_until, eligible_at, needs_action, unsubscribed, next_action_key")',
    );
  });
});
