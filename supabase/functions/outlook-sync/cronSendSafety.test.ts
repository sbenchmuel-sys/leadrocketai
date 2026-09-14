// Run: deno test --allow-env supabase/functions/outlook-sync/cronSendSafety.test.ts
//
// WHY THIS TEST EXISTS (Unit G-B, finding 5c)
// ============================================================================
// The audit recommends putting `outlook-sync` on the 20-minute cron so a rep's
// Outlook-sent mail comes back as a follow-up. The founder's hard constraint on
// that feature is:
//
//   "A periodic Outlook re-derive must only ever produce a follow-up card for a
//    human. It must never re-arm the automatic sender and must never send
//    anything itself, however long a lead has been silent."
//
// An earlier attempt shipped a "safety test" that grepped the source for the
// word "send". It passed, and the code would still have emailed contacts silent
// for a year — because the danger is not a send CALL inside outlook-sync, it is
// the ROW outlook-sync writes: `automation-executor`'s candidate query is
// key-agnostic —
//
//   needs_action = true AND eligible_at <= now() AND automation_mode IS NOT NULL
//   AND next_action_key <> 'ooo_return_followup'
//
// — so ANY key persisted next to a due `eligible_at` IS a send trigger.
//
// This test is BEHAVIOURAL: it runs outlook-sync's real derive path
// (`deriveAction` -> `buildLeadUpdate`, exactly as index.ts calls them) over a
// lead that has been silent for a year and is enrolled in automation, and
// asserts on the lead-update ROW that would be written.
//
// It currently asserts the HAZARD, not safety: the row DOES carry an
// outbound-send key with a due `eligible_at`. That is the proof that
// `outlook-sync` must NOT go on a cron as it stands — a periodic re-derive
// would hand automation-executor a year-silent lead to email.
//
// WHEN THE CRON UNIT IS BUILT: make the periodic path prompt-only (write
// `followup_due` with `eligible_at` explicitly NULL via
// `_shared/followupRule.ts::mustClearEligibleAt`), then flip the two assertions
// marked HAZARD below to assert `eligible_at === null` and a PROMPT_ONLY key.
// If the flip does not make this test fail first, the cron is not safe yet.
// ============================================================================

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  DEFAULT_CADENCE_SETTINGS,
  buildLeadUpdate,
  deriveAction,
  type LeadMetrics,
} from "../_shared/syncEngine.ts";
import { OUTBOUND_SEND_KEYS, PROMPT_ONLY_KEYS } from "../_shared/followupRule.ts";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

/** A lead the rep last emailed a year ago; the lead never replied. */
function silentForAYear(): LeadMetrics {
  return {
    first_outbound_at: daysAgo(400),
    last_outbound_at: daysAgo(365),
    last_inbound_at: null,
    meeting_summary_count: 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  };
}

/** Exactly the argument shape outlook-sync/index.ts passes. */
function deriveFor(metrics: LeadMetrics) {
  const cadence = DEFAULT_CADENCE_SETTINGS;
  return deriveAction(
    "lead-year-silent",
    metrics,
    /* nurtureCadence */ null,
    /* stage */ "contacted",
    /* hasMeetingWithoutFollowup */ false,
    /* hasFutureMeeting */ false,
    /* recentOutbound7d */ 0,
    /* recentOutbound30d */ 0,
    cadence.modes.fast,
    cadence.guardrails,
    cadence.stop_pause_rules,
    cadence.flows,
    /* timezone */ null,
    /* strategy */ "fast",
    /* motion */ "outbound_prospecting",
  );
}

Deno.test(
  "HAZARD: a periodic re-derive of a year-silent AUTOMATED lead writes a due send trigger",
  () => {
    const action = deriveFor(silentForAYear());
    const update = buildLeadUpdate(
      "contacted",
      silentForAYear(),
      action,
      /* actionDismissedAt */ null,
      {
        needs_action: false,
        eligible_at: null,
        motion: "outbound_prospecting",
        nurture_status: "inactive",
        ooo_until: null,
      },
      /* automationMode */ "auto", // the lead opted in to automation
    );

    // HAZARD 1 — the key written is one the executor treats as a scheduled send.
    assert(
      update.next_action_key !== null &&
        OUTBOUND_SEND_KEYS.has(update.next_action_key),
      `expected an outbound-send key, got ${update.next_action_key}`,
    );

    // HAZARD 2 — it is written with a non-null, already-due eligible_at, and
    // needs_action = true. Those three fields together ARE the executor's
    // candidate query. This row would be picked up and emailed.
    assertEquals(update.needs_action, true);
    assert(update.eligible_at !== null, "expected a non-null eligible_at");
    // Due now (this branch anchors on now(), so allow a minute of slack — the
    // executor runs every 15 minutes, so "now + seconds" is "this tick").
    assert(
      new Date(update.eligible_at as string).getTime() <= Date.now() + 60_000,
      `expected eligible_at to be due, got ${update.eligible_at}`,
    );
    assert(
      update.next_action_key !== "ooo_return_followup",
      "the executor's only key exclusion does not apply here",
    );
  },
);

Deno.test(
  "the consent gate DOES hold: the same lead with automation_mode = null gets no schedule",
  () => {
    const action = deriveFor(silentForAYear());
    const update = buildLeadUpdate(
      "contacted",
      silentForAYear(),
      action,
      null,
      {
        needs_action: false,
        eligible_at: null,
        motion: "outbound_prospecting",
        nurture_status: "inactive",
        ooo_until: null,
      },
      /* automationMode */ null,
    );

    assertEquals(update.next_action_key, null);
    assertEquals(update.eligible_at, null);
    assertEquals(update.needs_action, false);
  },
);

Deno.test(
  "prompt-only keys are never treated as sends (the shape a safe cron must write)",
  () => {
    for (const key of PROMPT_ONLY_KEYS) {
      assert(!OUTBOUND_SEND_KEYS.has(key), `${key} must not be an outbound send key`);
      const update = buildLeadUpdate(
        "contacted",
        silentForAYear(),
        {
          needs_action: true,
          next_action_key: key,
          next_action_label: "Follow up",
          eligible_at: new Date(Date.now() - DAY).toISOString(),
          action_reason_code: "FOLLOWUP_DUE",
        },
        null,
        {
          needs_action: false,
          eligible_at: null,
          motion: "outbound_prospecting",
          nurture_status: "inactive",
          ooo_until: null,
        },
        "auto",
      );
      // Even handed a due date, buildLeadUpdate must strip it for a prompt key.
      assertEquals(update.eligible_at, null, `${key} kept a due eligible_at`);
    }
  },
);
