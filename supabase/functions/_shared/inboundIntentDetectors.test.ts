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

import { DETERMINISTIC_INTENTS, detectInboundIntent } from "./inboundIntentDetectors.ts";
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

Deno.test("defer_request is not emitted (it must keep getting an ai_summary)", () => {
  assertEquals(DETERMINISTIC_INTENTS.includes("defer_request" as never), false);
});

// ── applyOOOPause: substantive question keeps the lead actionable ──

interface Captured { table: string; payload: Record<string, unknown> }

function fakeSupabase(captured: Captured[]) {
  // Minimal chainable stub: only .from().update().eq() and
  // .from().select().eq().single() are exercised by applyOOOPause.
  return {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          captured.push({ table, payload });
          return { eq: () => Promise.resolve({ error: null }) };
        },
        select() {
          return {
            eq: () => ({ single: () => Promise.resolve({ data: { personal_notes: "" } }) }),
          };
        },
        insert: () => Promise.resolve({ data: null, error: null }),
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
  await applyOOOPause({ supabase: fakeSupabase(captured) as any, ...OOO_ARGS, oooResult: ooo });

  const leadUpdate = captured.find((c) => c.table === "leads");
  assertEquals(leadUpdate?.payload.needs_action, false);
  assertEquals(leadUpdate?.payload.next_action_key, null);
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
  await applyOOOPause({ supabase: fakeSupabase(captured) as any, ...OOO_ARGS, oooResult: ooo });

  const leadUpdate = captured.find((c) => c.table === "leads");
  assertEquals(leadUpdate?.payload.needs_action, true);
  assertEquals(leadUpdate?.payload.next_action_key, "reply_now");
  assertEquals(leadUpdate?.payload.action_reason_code, "REPLY_PENDING");
  // The automation pause is still applied — we hold the robot, not the rep.
  assertEquals(typeof leadUpdate?.payload.eligible_at, "string");
});
