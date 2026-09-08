// ============================================================================
// Unit C1 — behavioural checks for the pure calling helpers.
// Deno suite: `npm run test:edge`.
//
// These execute the logic (the vitest file `src/test/callingSafety.test.ts`
// scans source text, because `src/` may not import Deno-flavoured modules).
// ============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildOutboundDialTwiml,
  RECORDING_NOTICE_TEXT,
  resolveAsrLanguages,
} from "./callConfig.ts";
import { callAnalysisDedupeKey, callDedupeKey } from "./timelineProjector.ts";

Deno.test("callAnalysisDedupeKey never collides with callDedupeKey", () => {
  const id = "1f1e0f6a-0000-4000-8000-000000000001";
  assert(callAnalysisDedupeKey(id) !== callDedupeKey(id));
  // Stable across calls — it is a dedupe key, re-runs must land on the same row.
  assertEquals(callAnalysisDedupeKey(id), callAnalysisDedupeKey(id));
});

Deno.test("resolveAsrLanguages: a Hebrew workspace gets English as the alternative", () => {
  const { primary, alternatives } = resolveAsrLanguages("he-IL", ["en-US", "es-US", "fr-CA"]);
  assertEquals(primary, "he-IL");
  assertEquals(alternatives, ["en-US"]);
});

Deno.test("resolveAsrLanguages: everyone else keeps their configured set", () => {
  const { primary, alternatives } = resolveAsrLanguages("en-US", ["en-US", "es-US", "fr-CA"]);
  assertEquals(primary, "en-US");
  // The primary is never repeated in the alternatives (Google rejects that).
  assertEquals(alternatives, ["es-US", "fr-CA"]);
});

Deno.test("resolveAsrLanguages: unset settings fall back to the defaults, capped at 3", () => {
  const { primary, alternatives } = resolveAsrLanguages(null, null);
  assertEquals(primary, "en-US");
  assert(alternatives.length <= 3);
  assert(!alternatives.includes("en-US"));
});

Deno.test("outbound TwiML speaks the recording notice before dialing", () => {
  const twiml = buildOutboundDialTwiml({
    to: "+972500000000",
    callerId: "+14155550123",
    statusCallbackUrl: "https://example.test/functions/v1/twilio-voice-webhook",
    recordingCallbackUrl: "https://example.test/functions/v1/twilio-voice-webhook",
    recordingNotice: true,
  });
  assert(twiml.indexOf("<Say") < twiml.indexOf("<Dial"), "notice must precede <Dial>");
  assert(twiml.includes(RECORDING_NOTICE_TEXT));
  assert(twiml.includes('record="record-from-answer-dual"'));
  assert(twiml.includes('callerId="+14155550123"'));
});

Deno.test("outbound TwiML honours a workspace that turned the notice off", () => {
  const twiml = buildOutboundDialTwiml({
    to: "+972500000000",
    callerId: "+14155550123",
    statusCallbackUrl: "https://example.test/a",
    recordingCallbackUrl: "https://example.test/b",
    recordingNotice: false,
  });
  assert(!twiml.includes("<Say"));
  assert(twiml.includes("<Dial"));
});

Deno.test("outbound TwiML escapes callback URLs so a query string cannot break the XML", () => {
  const twiml = buildOutboundDialTwiml({
    to: "+14155550000",
    callerId: "+14155550123",
    statusCallbackUrl: "https://example.test/cb?a=1&b=2",
    recordingCallbackUrl: "https://example.test/cb?a=1&b=2",
    recordingNotice: true,
  });
  assert(twiml.includes("a=1&amp;b=2"));
  assert(!twiml.includes("a=1&b=2"));
});
