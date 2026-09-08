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
import { matchWorkspaceByNumber, normalizeE164 } from "./phoneMapping.ts";

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

Deno.test("resolveAsrLanguages: an English workspace on the SHIPPED default gets NO alternatives", () => {
  // QA HOLD #3. call_settings.supported_languages defaults to
  // ['en-US','es-US','fr-CA'], so "non-empty" cannot mean "configured". A
  // dealership that never touched the setting must get exactly the
  // single-language request it got before this unit — otherwise its English
  // calls can come back partly transcribed as Spanish or French.
  const { primary, alternatives } = resolveAsrLanguages("en-US", ["en-US", "es-US", "fr-CA"]);
  assertEquals(primary, "en-US");
  assertEquals(alternatives, []);
});

Deno.test("resolveAsrLanguages: an EXPLICITLY configured list is honoured", () => {
  const { primary, alternatives } = resolveAsrLanguages("en-US", ["en-US", "es-US"]);
  assertEquals(primary, "en-US");
  // The primary is never repeated in the alternatives (Google rejects that).
  assertEquals(alternatives, ["es-US"]);
});

Deno.test("resolveAsrLanguages: unset settings produce no alternatives at all", () => {
  const { primary, alternatives } = resolveAsrLanguages(null, null);
  assertEquals(primary, "en-US");
  assertEquals(alternatives, []);
});

Deno.test("resolveAsrLanguages: he-IL wins even when the list is the shipped default", () => {
  // The Hebrew rule is keyed on the PRIMARY language, so an Israeli workspace
  // that never edited supported_languages still gets English as its fallback.
  const { alternatives } = resolveAsrLanguages("he-IL", ["en-US", "es-US", "fr-CA"]);
  assertEquals(alternatives, ["en-US"]);
});

Deno.test("resolveAsrLanguages: alternatives are capped at Google's limit of 3", () => {
  const { alternatives } = resolveAsrLanguages("en-US", ["de-DE", "it-IT", "pt-BR", "nl-NL", "pl-PL"]);
  assertEquals(alternatives.length, 3);
  assert(!alternatives.includes("en-US"));
});

Deno.test("matchWorkspaceByNumber matches across formatting differences", () => {
  // QA HOLD #2. A stored "+1 (415) 555-0123" and Twilio's "+14155550123" are
  // the same number; if they fail to match, the workspace's press-1 DTMF
  // consent gate silently reverts to OFF.
  const rows = [
    { workspace_id: "ws-a", default_twilio_number: "+1 (415) 555-0123" },
    { workspace_id: "ws-b", default_twilio_number: "+972-50-000-0000" },
  ];
  assertEquals(matchWorkspaceByNumber(rows, "+14155550123"), "ws-a");
  assertEquals(matchWorkspaceByNumber(rows, "+972500000000"), "ws-b");
  // Missing leading + on the incoming side still matches.
  assertEquals(matchWorkspaceByNumber(rows, "14155550123"), "ws-a");
});

Deno.test("matchWorkspaceByNumber fails closed — no single-workspace guess", () => {
  // The C1/9 leak: one configured workspace must NOT swallow an unknown number.
  const rows = [{ workspace_id: "ws-a", default_twilio_number: "+14155550123" }];
  assertEquals(matchWorkspaceByNumber(rows, "+14155559999"), null);
  assertEquals(matchWorkspaceByNumber([], "+14155550123"), null);
  assertEquals(matchWorkspaceByNumber(null, "+14155550123"), null);
  // A null stored number is not a wildcard.
  assertEquals(matchWorkspaceByNumber([{ workspace_id: "ws-x", default_twilio_number: null }], "+1"), null);
});

Deno.test("normalizeE164 strips formatting and forces a leading +", () => {
  assertEquals(normalizeE164("+1 (415) 555-0123"), "+14155550123");
  assertEquals(normalizeE164("14155550123"), "+14155550123");
  assertEquals(normalizeE164("  +972-50-000-0000 "), "+972500000000");
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
