// ============================================================
// Unit Q1 — the follow-up rule.
//
// Two layers, matching the pattern in queueInboundClassification.test.ts:
//
//   • BEHAVIOURAL, against the real pure module `@shared/followupRule` —
//     the rule itself, the wait-days defaults/override, and the two new
//     keys' contract with the Queue's urgency / chip / action-type maps.
//   • SOURCE-TEXT, against `_shared/syncEngine.ts` — deriveAction reads
//     `Deno.env` (getCorsHeaders), so `src/test/sharedPurity.test.ts`
//     forbids importing it here. These guards pin the WIRING: where the
//     rule is called from, that guardrails no longer return a null key,
//     and that no emittable key can be added without registering it.
//
// End-to-end deriveAction coverage lives in the Deno spec
// `supabase/functions/_shared/followupDue.test.ts` (npm run test:edge).
// ============================================================
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_FOLLOWUP_WAIT_DAYS,
  deriveFollowupDue,
  followupWaitDays,
  FOLLOWUP_DUE_KEY,
  HUMAN_PROMPT_KEYS,
  NON_QUEUE_ACTION_KEYS,
  OUTBOUND_SEND_KEYS,
  QUEUE_ACTION_KEYS,
  rateLimitedAction,
  RATE_LIMITED_KEY,
  startOfNextUtcDay,
} from "@shared/followupRule";
import { chipForLead, urgencyOf } from "@/lib/queueQueries";
import { getActionType } from "@/lib/dashboardUtils";

const ROOT = path.resolve(__dirname, "../..");
const SYNC_ENGINE = "supabase/functions/_shared/syncEngine.ts";
const syncEngineSrc = readFileSync(path.join(ROOT, SYNC_ENGINE), "utf8");

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// ── The rule ───────────────────────────────────────────────────────

describe("deriveFollowupDue — my unanswered message after N days", () => {
  it("surfaces a warm lead who replied two months ago and was emailed 4 days ago", () => {
    // THE six-week hole. syncEngine's old follow-up branch required
    // `!last_inbound_at`, so this lead had no follow-up rule at all and only
    // came back after the 45-day re-engagement window.
    const result = deriveFollowupDue(
      { last_inbound_at: daysAgo(60), last_outbound_at: daysAgo(4) },
      3,
      NOW,
    );
    expect(result?.next_action_key).toBe(FOLLOWUP_DUE_KEY);
    expect(result?.needs_action).toBe(true);
    expect(result?.action_reason_code).toBe("FOLLOWUP_DUE");
    expect(result?.next_action_label).toBe("Follow up (no reply in 3 days)");
  });

  it("surfaces a lead who never replied at all (unchanged coverage, now via one rule)", () => {
    const result = deriveFollowupDue(
      { last_inbound_at: null, last_outbound_at: daysAgo(4) },
      3,
      NOW,
    );
    expect(result?.next_action_key).toBe(FOLLOWUP_DUE_KEY);
  });

  it("stays quiet while the wait window is still open", () => {
    expect(deriveFollowupDue({ last_inbound_at: null, last_outbound_at: daysAgo(2) }, 3, NOW))
      .toBeNull();
  });

  it("never fires on a fresh inbound — that is a reply to answer, not a follow-up", () => {
    // Their message is the newest one: syncEngine's REPLY PENDING branch owns
    // this lead and must win.
    expect(
      deriveFollowupDue({ last_inbound_at: daysAgo(1), last_outbound_at: daysAgo(4) }, 3, NOW),
    ).toBeNull();
    // Same-instant inbound (a reply landing in the same sync) also defers.
    const t = daysAgo(4);
    expect(deriveFollowupDue({ last_inbound_at: t, last_outbound_at: t }, 3, NOW)).toBeNull();
  });

  it("stays quiet for a lead we have never emailed", () => {
    expect(deriveFollowupDue({ last_inbound_at: daysAgo(10), last_outbound_at: null }, 3, NOW))
      .toBeNull();
  });

  it("dates eligible_at at the due moment, not now (calendar days, not business days)", () => {
    const result = deriveFollowupDue(
      { last_inbound_at: null, last_outbound_at: daysAgo(10) },
      3,
      NOW,
    );
    expect(result?.eligible_at).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
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
    // Garbage in stored JSON falls back to the default rather than throwing.
    expect(followupWaitDays("fast", { followup_wait_days: Number.NaN })).toBe(3);
    expect(followupWaitDays("fast", { followup_wait_days: -2 })).toBe(3);
  });

  it("nurture waits longer than fast by default", () => {
    const emailed4dAgo = { last_inbound_at: daysAgo(60), last_outbound_at: daysAgo(4) };
    expect(deriveFollowupDue(emailed4dAgo, followupWaitDays("fast"), NOW)).not.toBeNull();
    expect(deriveFollowupDue(emailed4dAgo, followupWaitDays("nurture"), NOW)).toBeNull();
  });

  it("ships the same defaults in DEFAULT_CADENCE_SETTINGS (workspace override surface)", () => {
    // The setting lives in workspace_profiles.cadence_settings.modes.<mode>
    // (existing JSONB, deep-merged) — no new column.
    expect(syncEngineSrc).toMatch(/reply_pending_hours: 4,\s*\n\s*followup_wait_days: 3,/);
    expect(syncEngineSrc).toMatch(/reply_pending_hours: 24,\s*\n\s*followup_wait_days: 5,/);
  });
});

// ── The two new keys are prompts, never sends ──────────────────────

describe("followup_due / rate_limited are human prompts, not send triggers", () => {
  it("keeps followup_due out of the outbound-send key set", () => {
    expect(OUTBOUND_SEND_KEYS.has(FOLLOWUP_DUE_KEY)).toBe(false);
    expect(OUTBOUND_SEND_KEYS.has(RATE_LIMITED_KEY)).toBe(false);
    expect(OUTBOUND_SEND_KEYS.has("reply_now")).toBe(false);
    // Guard is not vacuous — the real send keys are still in there.
    expect(OUTBOUND_SEND_KEYS.has("send_pre_2")).toBe(true);
  });

  it("treats both as human-prompt keys so an armed cadence can't blank them", () => {
    expect(HUMAN_PROMPT_KEYS.has(FOLLOWUP_DUE_KEY)).toBe(true);
    expect(HUMAN_PROMPT_KEYS.has(RATE_LIMITED_KEY)).toBe(true);
    expect(HUMAN_PROMPT_KEYS.has("reply_now")).toBe(true);
  });

  it("blanks eligible_at before persisting them (automation-executor is key-agnostic)", () => {
    // The executor selects on needs_action + eligible_at <= now + consent, NOT
    // on the key. A prompt key with a due date would become an auto-send.
    expect(syncEngineSrc).toMatch(
      /leadUpdate\.next_action_key === "followup_due"[\s\S]{0,120}leadUpdate\.eligible_at = null;/,
    );
  });
});

// ── Guardrail suppression is visible ───────────────────────────────

describe("rate_limited — a suppressed lead stays visible with a date", () => {
  const availableAt = NOW + 2 * 86_400_000;

  it("stays in the queue instead of vanishing, and says when it comes back", () => {
    const result = rateLimitedAction(availableAt, "UTC");
    expect(result.needs_action).toBe(true);
    expect(result.next_action_key).toBe(RATE_LIMITED_KEY);
    expect(result.action_reason_code).toBe("RATE_LIMITED");
    expect(new Date(result.eligible_at!).getTime()).toBeGreaterThan(NOW);
    expect(result.next_action_label).toBe("Follow up available Sep 10");
  });

  it("renders the date in the workspace timezone, falling back to UTC", () => {
    // 2026-09-10T12:00Z is still Sep 10 in Los Angeles (05:00) and already
    // Sep 10 in Tokyo (21:00) — the point is that the tz is honoured, and that
    // garbage never throws.
    expect(rateLimitedAction(availableAt, "Asia/Tokyo").next_action_label)
      .toBe("Follow up available Sep 10");
    expect(rateLimitedAction(availableAt, "Not/AZone").next_action_label)
      .toBe("Follow up available Sep 10");
    expect(rateLimitedAction(availableAt, null).next_action_label)
      .toBe("Follow up available Sep 10");
  });

  it("expires the same-day guardrail at the next UTC midnight", () => {
    expect(new Date(startOfNextUtcDay(NOW)).toISOString()).toBe("2026-09-09T00:00:00.000Z");
  });

  it("replaces every silent guardrail drop in deriveAction", () => {
    const guardrailBlock = syncEngineSrc.slice(
      syncEngineSrc.indexOf("\n  // GUARDRAILS\n"),
      syncEngineSrc.indexOf("\n  // STOP RULES\n"),
    );
    expect(guardrailBlock.length).toBeGreaterThan(0);
    // Four guardrails (7d cap, 30d cap, min-gap, same-day) — each now returns
    // the owed follow-up or an honest rate_limited, never a null key.
    expect(guardrailBlock.match(/followupDue \?\? rateLimitedAction\(/g)?.length).toBe(4);
    expect(guardrailBlock).not.toContain("next_action_key: null");
  });
});

// ── Wiring inside deriveAction ─────────────────────────────────────

describe("deriveAction wiring", () => {
  it("evaluates the follow-up rule after REPLY PENDING and before the guardrails", () => {
    const replyPending = syncEngineSrc.indexOf("// A) REPLY PENDING");
    const followup = syncEngineSrc.indexOf("const followupDue = deriveFollowupDue(");
    const guardrails = syncEngineSrc.indexOf("  // GUARDRAILS");
    expect(replyPending).toBeGreaterThan(-1);
    expect(followup).toBeGreaterThan(replyPending);
    expect(guardrails).toBeGreaterThan(followup);
  });

  it("falls back to followup_due instead of dropping the lead entirely", () => {
    expect(syncEngineSrc).toContain(
      "return followupDue ?? { needs_action: false, next_action_key: null",
    );
  });

  it("keeps the existing keys and their order (they are labels on the same rule)", () => {
    const order = [
      "closing_followup",
      "switch_to_nurture",
      "send_pre_4",
      "generate_post_meeting_recap",
      "post_meeting_followup",
      "send_nurture_",
      "reengage",
    ];
    const positions = order.map((k) => syncEngineSrc.indexOf(`next_action_key: "${k}`) >= 0
      ? syncEngineSrc.indexOf(`next_action_key: "${k}`)
      : syncEngineSrc.indexOf(`next_action_key: \`${k}`));
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

// ── Every emittable key is registered everywhere it is consumed ────

describe("action-key registry", () => {
  /** Every literal/template assigned to next_action_key inside syncEngine. */
  const emitted = new Set<string>();
  for (const m of syncEngineSrc.matchAll(/next_action_key: ["`]([A-Za-z0-9_${}+ ]+)["`]/g)) {
    // `send_nurture_${...}` / `send_pre_${...}` collapse to their family.
    emitted.add(m[1].replace(/\$\{[^}]*\}/g, "N").replace(/_N$/, "_1"));
  }

  it("finds the keys (guard is not vacuous)", () => {
    expect(emitted.size).toBeGreaterThan(5);
  });

  it("has no key syncEngine can emit that the registry doesn't know", () => {
    const known = new Set([
      ...QUEUE_ACTION_KEYS,
      ...NON_QUEUE_ACTION_KEYS,
      // Cadence steps 2-4 are emitted from one template; step 1 stands in.
      "send_pre_1", "send_pre_2", "send_pre_3", "send_pre_4",
    ]);
    expect([...emitted].filter((k) => !known.has(k))).toEqual([]);
  });

  it.each(QUEUE_ACTION_KEYS)("%s has a Queue urgency, a chip and an action type", (key) => {
    // Urgency map: an unregistered key sorts to 100 (bottom, indistinguishable
    // from "unknown") — that's the blank-card failure mode.
    expect(urgencyOf(key)).toBeLessThan(100);
    // Tab routing: everything that is not the customer waiting is "Follow up".
    const bucket = chipForLead({ next_action_key: key, action_resurfaced_at: null });
    expect(bucket).not.toBeNull();
    expect(bucket).toBe(key === "reply_now" ? "replied" : "followup_due");
    // Action-type map: "view" is the fallback, so only keys that are genuinely
    // read-only may land there.
    // `reengage` maps to "view" today — a pre-existing gap in getActionType
    // that predates this unit and is deliberately not widened here (changing
    // it would change the dashboard CTA for cold leads). Listed so the guard
    // stays honest rather than silently green.
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
