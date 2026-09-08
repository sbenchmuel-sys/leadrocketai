// ============================================================================
// Unit C1 — behavioural checks for the pure calling helpers.
// Deno suite: `npm run test:edge`.
//
// These execute the logic (the vitest file `src/test/callingSafety.test.ts`
// scans source text, because `src/` may not import Deno-flavoured modules).
// ============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCalleeNoticeTwiml,
  buildOutboundDialTwiml,
  CALLEE_NOTICE_PARAM,
  CALLEE_NOTICE_VALUE,
  calleeNoticeUrl,
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

const DIAL_ARGS = {
  to: "+972500000000",
  callerId: "+14155550123",
  statusCallbackUrl: "https://example.test/functions/v1/twilio-voice-webhook",
  recordingCallbackUrl: "https://example.test/functions/v1/twilio-voice-webhook",
  recordingNotice: true,
  calleeNoticeUrl: calleeNoticeUrl("https://example.test/functions/v1/twilio-voice-inbound"),
};

Deno.test("the rep's <Dial> document contains NO <Say> — it would play to the rep", () => {
  // The rejected first version put the notice here. This TwiML runs on the
  // rep's Twilio Client leg, BEFORE Twilio dials the <Number>, so the prospect
  // never heard it and was recorded without notice.
  const twiml = buildOutboundDialTwiml(DIAL_ARGS);
  assert(!twiml.includes("<Say"), "a <Say> here plays to the REP, not the callee");
});

Deno.test("the notice rides the callee leg via the url attribute on <Number>", () => {
  const twiml = buildOutboundDialTwiml(DIAL_ARGS);
  const numberTag = /<Number[^>]*>/.exec(twiml)?.[0] ?? "";
  assert(numberTag.length > 0, "expected a <Number> tag");
  assert(
    numberTag.includes(`${CALLEE_NOTICE_PARAM}=${CALLEE_NOTICE_VALUE}`),
    "the notice url must be an attribute of <Number>, so Twilio plays it on the CALLED leg",
  );
  assert(numberTag.includes('method="POST"'));
  // The recording really is on, so the notice is load-bearing.
  assert(twiml.includes('record="record-from-answer-dual"'));
  assert(twiml.includes('callerId="+14155550123"'));
});

Deno.test("what the callee-notice endpoint returns is the actual spoken notice", () => {
  const twiml = buildCalleeNoticeTwiml();
  assert(twiml.includes("<Say"));
  assert(twiml.includes(RECORDING_NOTICE_TEXT));
  // Nothing else — it is played mid-dial and must not hang up or redirect.
  assert(!twiml.includes("<Hangup"));
  assert(!twiml.includes("<Dial"));
});

Deno.test("calleeNoticeUrl appends the marker the inbound branch keys on", () => {
  const url = calleeNoticeUrl("https://example.test/functions/v1/twilio-voice-inbound");
  assertEquals(
    url,
    `https://example.test/functions/v1/twilio-voice-inbound?${CALLEE_NOTICE_PARAM}=${CALLEE_NOTICE_VALUE}`,
  );
  // Round-trips through URL parsing the way the edge function reads it.
  assertEquals(new URL(url).searchParams.get(CALLEE_NOTICE_PARAM), CALLEE_NOTICE_VALUE);
});

Deno.test("outbound TwiML honours a workspace that turned the notice off", () => {
  const twiml = buildOutboundDialTwiml({ ...DIAL_ARGS, recordingNotice: false });
  assert(!twiml.includes("<Say"));
  // No url attribute at all → straight bridge, no whisper.
  assert(!twiml.includes(CALLEE_NOTICE_VALUE));
  assert(twiml.includes("<Dial"));
});

Deno.test("outbound TwiML escapes callback URLs so a query string cannot break the XML", () => {
  // The callee-notice url itself carries a query string, so this is not theoretical.
  const twiml = buildOutboundDialTwiml({
    ...DIAL_ARGS,
    statusCallbackUrl: "https://example.test/cb?a=1&b=2",
    recordingCallbackUrl: "https://example.test/cb?a=1&b=2",
  });
  assert(twiml.includes("a=1&amp;b=2"));
  assert(!twiml.includes("a=1&b=2"));
});
