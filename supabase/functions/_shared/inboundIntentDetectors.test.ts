// Deno-side tests for the deterministic inbound-intent chain and the two
// detector fixes that ride with it (tentative accepts, OOO substantive
// questions). The vitest mirror in src/test/queueInboundClassification.test.ts
// covers the same behaviour for the browser-side build; this file is the one
// that runs against the real Deno import graph.
//
// NOTE: `npm run test:edge` cannot run in the build sandbox (deno.land and
// esm.sh are blocked by network policy), so this file was written but not
// executed here.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  DETERMINISTIC_INTENTS,
  detectInboundIntent,
  hasSubstantiveQuestion,
  readSubstantiveQuestionFlag,
  senderIsLead,
  SUBSTANTIVE_QUESTION_FLAG,
} from "./inboundIntentDetectors.ts";
import { detectMeetingConfirmation, isTentativeAccept } from "./meetingConfirmation.ts";
import { isOutOfOfficeReply } from "./oooDetection.ts";
import { applyOOOPause } from "./oooPauseActions.ts";

// ── detector chain ────────────────────────────────────────────────

Deno.test("bounce wins the precedence chain", () => {
  const r = detectInboundIntent({
    fromEmail: "mailer-daemon@googlemail.com",
    subject: "Delivery Status Notification (Failure)",
    body: "See you Tuesday",
  });
  assertEquals(r.intent, "bounce");
});

Deno.test("ooo_reply beats meeting confirmation", () => {
  const r = detectInboundIntent({
    fromEmail: "dana@acme.com",
    subject: "Automatic reply: Re: pilot",
    body: "I am out of the office until March 5. See you Tuesday.",
  });
  assertEquals(r.intent, "ooo_reply");
});

Deno.test("header signal is used when the caller has headers", () => {
  const r = detectInboundIntent({
    fromEmail: "dana@acme.com",
    subject: "Re: pilot",
    body: "back soon",
    headers: [{ name: "Auto-Submitted", value: "auto-replied" }],
  });
  assertEquals(r.intent, "ooo_reply");
});

Deno.test("firm calendar accept classifies, tentative does not", () => {
  assertEquals(
    detectInboundIntent({
      fromEmail: "d@acme.com",
      subject: "Accepted: Intro call @ Tue",
      body: "",
    }).intent,
    "calendar_accept",
  );
  assertEquals(
    detectInboundIntent({
      fromEmail: "d@acme.com",
      subject: "Tentatively Accepted: Intro call @ Tue",
      body: "",
    }).intent,
    null,
  );
  assertEquals(isTentativeAccept("Tentatively Accepted: Intro call @ Tue"), true);
  assertEquals(
    detectMeetingConfirmation("Tentatively Accepted: Intro call @ Tue", "").isConfirmed,
    false,
  );
});

Deno.test("a substantive human reply falls through to the AI", () => {
  assertEquals(
    detectInboundIntent({
      fromEmail: "d@acme.com",
      subject: "Re: pilot",
      body: "Can you send the enterprise pricing for 50 seats?",
    }).intent,
    null,
  );
});

Deno.test("an OOO carrying a commercial question is NOT labelled ooo_reply", () => {
  // ooo_reply is in the Queue's hide set, so labelling this would undo the
  // needs_action that applyOOOPause deliberately keeps (see below) and the
  // lead would vanish within one classification cycle.
  const r = detectInboundIntent({
    fromEmail: "dana@acme.com",
    subject: "Automatic reply: Re: pilot",
    body: "I'm out of the office until March 5. Before then, can you send the updated pricing?",
  });
  assertEquals(r.intent, null);
  assertEquals(r.ooo?.isOOO, true);
  assertEquals(r.ooo?.hasSubstantiveQuestion, true);
});

// ── sender identity ───────────────────────────────────────────────

Deno.test("senderIsLead: true on exact match, alias and display name", () => {
  assertEquals(senderIsLead("dana@acme.com", "dana@acme.com"), true);
  assertEquals(senderIsLead('"Dana Ruiz" <Dana@Acme.com>', "dana@acme.com"), true);
  assertEquals(senderIsLead("dana+drivepilot@acme.com", "dana@acme.com"), true);
});

Deno.test("senderIsLead: null (not false) when only the local part differs", () => {
  // `false` hides a Queue card, so a shared inbox or a second address at
  // the lead's own company must stay unknown rather than be suppressed.
  assertEquals(senderIsLead("procurement@acme.com", "dana@acme.com"), null);
  assertEquals(senderIsLead("d.ruiz@acme.com", "dana@acme.com"), null);
});

Deno.test("senderIsLead: false only when the domain differs too", () => {
  assertEquals(senderIsLead("vendor@other.com", "dana@acme.com"), false);
});

Deno.test("senderIsLead: null when either side is missing or unparseable", () => {
  assertEquals(senderIsLead("", "dana@acme.com"), null);
  assertEquals(senderIsLead("dana@acme.com", null), null);
  assertEquals(senderIsLead("not-an-email", "dana@acme.com"), null);
});

Deno.test("defer_request is not emitted (it must keep getting an ai_summary)", () => {
  assertEquals(DETERMINISTIC_INTENTS.includes("defer_request" as never), false);
});

// ── applyOOOPause: substantive question keeps the lead actionable ──

interface Captured { table: string; payload: Record<string, unknown> }

function fakeSupabase(captured: Captured[]) {
  // Minimal chainable stub covering exactly what applyOOOPause reaches:
  //   .from().update().eq()
  //   .from().select().eq().single()          (personal_notes read)
  //   .from().insert().select().single()      (createCanonicalInteraction,
  //                                            canonicalInteraction.ts:214-218)
  // `insert` MUST return the chainable shape, not a bare promise — the real
  // code calls .select("id").single() on it, so a promise double makes the
  // helper throw and the assertions below never run.
  return {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          captured.push({ table, payload });
          // .eq() is chained 1–2 deep depending on the call site, and the
          // result is awaited. Self-returning + thenable covers both.
          const node: Record<string, unknown> = {
            then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
          };
          node.eq = () => node;
          return node;
        },
        // Chainable and self-returning so the timeline projection's
        // .eq().eq().maybeSingle() lookup resolves quietly too. (That call
        // is inside canonicalInteraction's try/catch, so it cannot affect
        // the assertions either way — this just keeps the run warning-free.)
        select() {
          const node: Record<string, unknown> = {
            single: () => Promise.resolve({ data: { personal_notes: "" }, error: null }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          };
          node.eq = () => node;
          node.limit = () => node;
          node.order = () => node;
          return node;
        },
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: "i1" }, error: null }),
          }),
        }),
        // timelineProjector.ts:98 — awaited directly, no chaining.
        upsert: () => Promise.resolve({ error: null }),
      };
    },
  };
}

const OOO_ARGS = {
  leadId: "lead-1",
  workspaceId: "ws-1",
  leadName: "Dana",
  occurredAt: new Date().toISOString(),
  logPrefix: "[test]",
};

Deno.test("plain OOO clears needs_action", async () => {
  const captured: Captured[] = [];
  const ooo = isOutOfOfficeReply(
    [],
    "Automatic reply: Re: pilot",
    "I'm out of the office until March 5 with limited access to email.",
  );
  assertEquals(ooo.hasSubstantiveQuestion, false);

  // deno-lint-ignore no-explicit-any
  const r = await applyOOOPause({ supabase: fakeSupabase(captured) as any, ...OOO_ARGS, oooResult: ooo });

  const leadUpdate = captured.find((c) => c.table === "leads");
  assertEquals(leadUpdate?.payload.needs_action, false);
  assertEquals(leadUpdate?.payload.next_action_key, null);
  // Routine auto-reply: caller SHOULD skip its normal inbound-store path.
  assertEquals(r.paused, true);
  assertEquals(r.skipInbound, true);
});

Deno.test("OOO carrying a commercial question keeps needs_action", async () => {
  const captured: Captured[] = [];
  const ooo = isOutOfOfficeReply(
    [],
    "Automatic reply: Re: pilot",
    "I'm out of the office until March 5. Before then, can you send the updated pricing?",
  );
  assertEquals(ooo.hasSubstantiveQuestion, true);

  // deno-lint-ignore no-explicit-any
  const r = await applyOOOPause({ supabase: fakeSupabase(captured) as any, ...OOO_ARGS, oooResult: ooo });

  const leadUpdate = captured.find((c) => c.table === "leads");
  assertEquals(leadUpdate?.payload.needs_action, true);
  assertEquals(leadUpdate?.payload.next_action_key, "reply_now");
  assertEquals(leadUpdate?.payload.action_reason_code, "REPLY_PENDING");
  // The automation pause is still applied — we hold the robot, not the rep.
  assertEquals(typeof leadUpdate?.payload.eligible_at, "string");
  // …and, the P1: the caller must STILL STORE this inbound. Marking the
  // lead actionable while telling the caller to drop the message points
  // the rep at a reply that was never inserted.
  assertEquals(r.paused, true);
  assertEquals(r.skipInbound, false);
});

// ── the same theme, two more places ───────────────────────────────

Deno.test("an accept carrying a commercial question is NOT calendar_accept", () => {
  const r = detectInboundIntent({
    fromEmail: "dana@acme.com",
    subject: "Accepted: Demo @ Tue Mar 3",
    body: "Looks good. Quick one before then — can you send the pricing for 50 seats?",
  });
  assertEquals(r.meeting?.isConfirmed, true);
  assertEquals(r.meeting?.hasSubstantiveQuestion, true);
  assertEquals(r.intent, null);
});

Deno.test("a clean accept is still calendar_accept", () => {
  assertEquals(
    detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Accepted: Demo @ Tue Mar 3",
      body: "See you then!",
    }).intent,
    "calendar_accept",
  );
});

Deno.test("unsubscribe: quoted history is not the sender's opt-out", () => {
  const body = [
    "Sounds good, can you send the contract?",
    "",
    "On Mon, Mar 3, 2026 at 9:02 AM Rep <rep@us.com> wrote:",
    "> Happy to help. To unsubscribe, click here.",
  ].join("\n");
  assertEquals(
    detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Re: pilot",
      body,
      headers: [],
    }).intent,
    null,
  );
});

Deno.test("unsubscribe: no headers → no deterministic verdict", () => {
  assertEquals(
    detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Re: pilot",
      body: "Please unsubscribe me from this list.",
    }).intent,
    null,
  );
});

Deno.test("unsubscribe: List-Unsubscribe header means newsletter, not opt-out", () => {
  assertEquals(
    detectInboundIntent({
      fromEmail: "news@vendor.com",
      subject: "March digest",
      body: "Lots of news. Click here to unsubscribe.",
      headers: [{ name: "List-Unsubscribe", value: "<mailto:x@vendor.com>" }],
    }).intent,
    null,
  );
});

Deno.test("unsubscribe: a real opt-out WITH header context still classifies", () => {
  assertEquals(
    detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Re: pilot",
      body: "Please remove me from your list.",
      headers: [{ name: "From", value: "dana@acme.com" }],
    }).intent,
    "unsubscribe",
  );
});

// ── the full-body verdict beats the truncated snippet (Codex P1) ──

Deno.test("a persisted `true` overrides what the 500-char snippet shows", () => {
  const truncated = "I am out of the office until March 5 with limited access to email.";
  assertEquals(
    detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Automatic reply: Re: pilot",
      body: truncated,
    }).intent,
    "ooo_reply",
  );
  assertEquals(
    detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Automatic reply: Re: pilot",
      body: truncated,
      substantiveQuestion: true,
    }).intent,
    null,
  );
});

Deno.test("a persisted `false` is trusted, not re-derived", () => {
  assertEquals(
    detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Automatic reply: Re: pilot",
      body: "I'm away. Can you resend the pricing?",
      substantiveQuestion: false,
    }).intent,
    "ooo_reply",
  );
});

Deno.test("the override flag round-trips through metadata_json", () => {
  assertEquals(SUBSTANTIVE_QUESTION_FLAG, "has_substantive_question");
  assertEquals(readSubstantiveQuestionFlag({ [SUBSTANTIVE_QUESTION_FLAG]: true }), true);
  assertEquals(readSubstantiveQuestionFlag({ [SUBSTANTIVE_QUESTION_FLAG]: false }), false);
  assertEquals(readSubstantiveQuestionFlag({}), undefined);
  assertEquals(readSubstantiveQuestionFlag(null), undefined);
  assertEquals(readSubstantiveQuestionFlag({ [SUBSTANTIVE_QUESTION_FLAG]: "yes" }), undefined);
});

// ── the question check reads only the sender's prose (Codex P2) ──

Deno.test("our own quoted pitch is not the sender asking a question", () => {
  const autoReply = [
    "Automatic reply: I am out of the office until March 5.",
    "",
    "On Mon, Mar 3, 2026 at 9:02 AM Rep <rep@us.com> wrote:",
    "> Would pricing details help before we meet?",
  ].join("\n");
  assertEquals(hasSubstantiveQuestion(autoReply), false);
  const r = detectInboundIntent({
    fromEmail: "dana@acme.com",
    subject: "Automatic reply: Re: pilot",
    body: autoReply,
  });
  assertEquals(r.ooo?.hasSubstantiveQuestion, false);
  assertEquals(r.intent, "ooo_reply");
});

Deno.test("a question the sender typed above the quote still counts", () => {
  const body = [
    "I'm out until March 5. Before then — can you send the updated pricing?",
    "",
    "On Mon, Mar 3, 2026 at 9:02 AM Rep <rep@us.com> wrote:",
    "> Here's the deck.",
  ].join("\n");
  assertEquals(hasSubstantiveQuestion(body), true);
  assertEquals(
    detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Automatic reply: Re: pilot",
      body,
    }).intent,
    null,
  );
});

Deno.test("a quoted-pitch auto-reply is dropped, not stored as real inbound", async () => {
  // The P2 and P1(1) fixes meeting: no real question → skipInbound true →
  // the caller drops it → no false reply_now is left behind.
  const captured: Captured[] = [];
  const ooo = isOutOfOfficeReply(
    [],
    "Automatic reply: Re: pilot",
    [
      "I am out of the office until March 5.",
      "",
      "On Mon, Mar 3, 2026 at 9:02 AM Rep <rep@us.com> wrote:",
      "> Would pricing details help before we meet?",
    ].join("\n"),
  );
  assertEquals(ooo.hasSubstantiveQuestion, false);
  // deno-lint-ignore no-explicit-any
  const r = await applyOOOPause({ supabase: fakeSupabase(captured) as any, ...OOO_ARGS, oooResult: ooo });
  assertEquals(r.skipInbound, true);
  assertEquals(captured.find((c) => c.table === "leads")?.payload.needs_action, false);
});
