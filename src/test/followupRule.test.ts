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
  followupSweepCutoffIso,
  isFollowupSweepCandidate,
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

describe("followupWaitDays — 3 fast, 5 nurture, workspace can override", () => {
  it("defaults to 3 days for fast motion", () => {
    expect(followupWaitDays("fast", undefined)).toBe(DEFAULT_FOLLOWUP_WAIT_DAYS.fast);
    expect(followupWaitDays("fast", {})).toBe(3);
  });

  it("defaults to 5 days for nurture", () => {
    expect(followupWaitDays("nurture", undefined)).toBe(DEFAULT_FOLLOWUP_WAIT_DAYS.nurture);
    expect(followupWaitDays("nurture", { followup_wait_days: null })).toBe(5);
  });

  it("uses the workspace setting when one is configured", () => {
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

  it("blanks eligible_at before persisting them", () => {
    expect(syncEngineSrc).toMatch(
      /PROMPT_ONLY_KEYS\.has\(leadUpdate\.next_action_key\)[\s\S]{0,80}leadUpdate\.eligible_at = null;/,
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


// ── The Outlook hole: something must revisit a quiet lead ──────────
//
// The post-send recompute runs seconds after the send, when the answer is
// correctly "nothing to do". Gmail gets a second look from its bulk-sync cron;
// Outlook had none, so the lead was never re-derived and the six-week hole
// stayed open for Outlook reps. `outlook-followup-sweep` is that second look.

describe("outlook-followup-sweep — the lead a manual Outlook send leaves behind", () => {
  // Exactly the row a manual Outlook send leaves: analyze_outgoing_email wrote
  // needs_action=false, and postSendDeriveAction agreed (nothing was due yet).
  // A warm lead: they wrote two months ago, the rep answered from Outlook four
  // days ago, and nothing has come back.
  const fourDaysAfterAnOutlookSend = {
    needs_action: false,
    next_action_key: null,
    last_outbound_at: daysAgo(4),
    last_inbound_at: daysAgo(60),
    unsubscribed: false,
    status: "active",
    action_permanently_dismissed: false,
    action_dismissed_at: null,
  };

  it("picks the lead up four days later", () => {
    expect(isFollowupSweepCandidate(fourDaysAfterAnOutlookSend, NOW)).toBe(true);
  });

  it("and re-deriving it puts it in the Queue", () => {
    // The other half of the proof: the sweep hands this lead to the same
    // deriveAction a sync would, and it comes back as work for the rep.
    const r = withFrozenClock(() => derive(metrics({
      first_outbound_at: daysAgo(70),
      last_outbound_at: fourDaysAfterAnOutlookSend.last_outbound_at,
      last_inbound_at: fourDaysAfterAnOutlookSend.last_inbound_at,
    })));
    expect(r.next_action_key).toBe(FOLLOWUP_DUE_KEY);
    expect(r.needs_action).toBe(true);
    expect(chipForLead({ next_action_key: r.next_action_key, action_resurfaced_at: null }))
      .toBe("followup_due");
  });

  it("leaves alone leads that need nothing", () => {
    const skip = (over: Record<string, unknown>) =>
      expect(isFollowupSweepCandidate({ ...fourDaysAfterAnOutlookSend, ...over }, NOW)).toBe(false);
    skip({ needs_action: true });                       // already in the Queue
    skip({ unsubscribed: true });
    skip({ status: "closed_won" });
    skip({ action_permanently_dismissed: true });
    skip({ action_dismissed_at: daysAgo(1) });          // snoozed / handled
    skip({ last_outbound_at: null });                   // never emailed
    skip({ last_outbound_at: hoursAgo(2) });            // too recent to be due
    skip({ last_inbound_at: daysAgo(1) });              // they wrote last — reply_now's job
    skip({ last_outbound_at: null, last_inbound_at: null }); // never emailed at all
  });

  it("cuts off at the wait floor, not at the 3/5-day default", () => {
    // The sweep must not second-guess the per-workspace wait; deriveAction
    // applies the real number.
    expect(followupSweepCutoffIso(NOW)).toBe(new Date(NOW - 86_400_000).toISOString());
  });

  it("is a recompute-only job — it must never send or arm", () => {
    const fn = readFileSync(
      path.join(ROOT, "supabase/functions/outlook-followup-sweep/index.ts"), "utf8");
    // Reuses the one recompute path rather than copying the rule.
    expect(fn).toContain("recomputeLeadAction(");
    expect(fn).toContain("isFollowupSweepCandidate(");
    // Cron-only entry point.
    expect(fn).toContain("requireScheduledCaller(");
    // No sending, no arming, no consent writes.
    expect(fn).not.toMatch(/gmail-send|outlook-send|automation_mode|eligible_at:/);
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

  it.each([FOLLOWUP_DUE_KEY, RATE_LIMITED_KEY])("keeps a %s lead visible", (key) => {
    expect(belongsInReactiveTabs({ ...afterTheRepAnswered, next_action_key: key })).toBe(true);
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

  it("the sweep does NOT ask for it — no AI ran, so deriveStage is canonical there", () => {
    const fn = readFileSync(
      path.join(ROOT, "supabase/functions/outlook-followup-sweep/index.ts"), "utf8");
    expect(fn).not.toContain("preserveStage");
  });
});
