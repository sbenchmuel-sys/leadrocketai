// ============================================================================
// Unit C1 — calling safety guards.
//
// Source-text scans, same style as coldAutoSendGate.test.ts and
// singleSourceGuards.test.ts. Source-text (rather than importing and executing
// the modules) because every file under test is a Deno edge function or an
// impure `_shared` module — `src/test/sharedPurity.test.ts` forbids `src/`
// from importing anything that touches `Deno.` or `esm.sh`, which is all of
// them. The behavioural counterparts live in the Deno suite:
// `supabase/functions/_shared/callSafety.test.ts` (`npm run test:edge`).
//
// Each guard pins one thing that, if it silently regressed, would put a real
// call, a real recording, or a real tenant's data at risk.
// ============================================================================
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const FN = "supabase/functions";
const voiceInbound = () => read(`${FN}/twilio-voice-inbound/index.ts`);
const voiceWebhook = () => read(`${FN}/twilio-voice-webhook/index.ts`);
const callAnalyze = () => read(`${FN}/call-analyze/index.ts`);
const callTranscribe = () => read(`${FN}/call-transcribe/index.ts`);
const callIngest = () => read(`${FN}/call-ingest-recording/index.ts`);
const projector = () => read(`${FN}/_shared/timelineProjector.ts`);
const phoneMapping = () => read(`${FN}/_shared/phoneMapping.ts`);
const asrProvider = () => read(`${FN}/_shared/asrProvider.ts`);
const callConfig = () => read(`${FN}/_shared/callConfig.ts`);

/** Strip // and /* *\/ comments so a rule never matches its own explanation. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("C1 — the AI summary reaches the timeline", () => {
  // The analysis row used to reuse callDedupeKey(), colliding with the row
  // twilio-voice-webhook already wrote. projectTimelineItem keeps the FIRST
  // row's snippet on conflict, so the summary was silently thrown away.
  it("analysisDedupeKeyDistinct — the analysis key differs from the call key", () => {
    const src = projector();

    // Both builders exist...
    expect(src).toMatch(/export function callDedupeKey\(/);
    expect(src).toMatch(/export function callAnalysisDedupeKey\(/);

    // ...and their literal prefixes differ, so the same session id can never
    // produce the same key from both.
    const callPrefix = /export function callDedupeKey\([\s\S]*?return `([^$]*)\$\{/.exec(src)?.[1];
    const analysisPrefix =
      /export function callAnalysisDedupeKey\([\s\S]*?return `([^$]*)\$\{/.exec(src)?.[1];
    expect(callPrefix).toBeTruthy();
    expect(analysisPrefix).toBeTruthy();
    expect(analysisPrefix).not.toBe(callPrefix);

    // call-analyze projects with the ANALYSIS key, not the call key.
    const analyze = stripComments(callAnalyze());
    expect(analyze).toMatch(/dedupe_key:\s*callAnalysisDedupeKey\(callSessionId\)/);
    expect(analyze).not.toMatch(/dedupe_key:\s*callDedupeKey\(/);
  });

  it("the original call row's snippet is refreshed with the summary", () => {
    const analyze = stripComments(callAnalyze());
    // A direct update keyed on callDedupeKey — the projector deliberately
    // refuses to overwrite a non-empty snippet, so it cannot do this job.
    expect(analyze).toMatch(/\.from\("lead_timeline_items"\)[\s\S]{0,400}?callDedupeKey\(callSessionId\)/);
    expect(analyze).toMatch(/snippet_text:\s*summary\.substring\(0, 500\)/);
  });

  it("noInteractionsWrite — call-analyze never writes to the legacy interactions table", () => {
    const analyze = stripComments(callAnalyze());
    expect(analyze).not.toMatch(/from\(["']interactions["']\)/);
  });

  it("call-analyze selects started_at, which its timeline write reads", () => {
    const analyze = stripComments(callAnalyze());
    const select = /\.from\("call_sessions"\)\s*\.select\("([^"]+)"\)/.exec(analyze)?.[1] ?? "";
    expect(select.split(/\s*,\s*/)).toContain("started_at");
  });
});

describe("C1 — outbound call safety", () => {
  it("signatureBeforeBrowserBranch — the Twilio signature is validated first", () => {
    const src = stripComments(voiceInbound());
    const sigCheck = src.indexOf("validateTwilioSignature(");
    const browserBranch = src.indexOf("isBrowserCall");
    expect(sigCheck).toBeGreaterThan(-1);
    expect(browserBranch).toBeGreaterThan(-1);
    expect(sigCheck).toBeLessThan(browserBranch);

    // Fail-closed: no auth token or no signature must still reject.
    expect(src).toMatch(/isValid\s*=\s*twilioAuthToken && signature/);
    expect(src).toMatch(/if \(!isValid\)[\s\S]{0,400}status:\s*403/);
  });

  it("outboundRecordingNotice — the outbound TwiML says the notice before <Dial>", () => {
    const src = callConfig();
    const body = /export function buildOutboundDialTwiml\([\s\S]*?\n}\n/.exec(src)?.[0] ?? "";
    expect(body).toBeTruthy();

    const say = body.indexOf("<Say");
    const dial = body.indexOf("<Dial");
    expect(say).toBeGreaterThan(-1);
    expect(dial).toBeGreaterThan(-1);
    expect(say).toBeLessThan(dial);

    // The notice actually says the call is recorded, and the outbound leg
    // really is recording (so the notice is not decorative).
    expect(src).toMatch(/RECORDING_NOTICE_TEXT\s*=\s*\n?\s*"This call may be recorded/);
    expect(body).toMatch(/record="record-from-answer-dual"/);

    // ...and twilio-voice-inbound builds its outbound TwiML through it rather
    // than hand-rolling a <Dial> with no notice.
    const inbound = stripComments(voiceInbound());
    expect(inbound).toMatch(/buildOutboundDialTwiml\(\{/);
  });

  it("repCallerNumberPreferred — the rep's own number wins over the workspace default", () => {
    const src = stripComments(voiceInbound());
    const repLookup = src.indexOf('.from("rep_profiles")');
    const wsDefault = src.indexOf("default_twilio_number");
    expect(repLookup).toBeGreaterThan(-1);
    expect(wsDefault).toBeGreaterThan(repLookup);

    // The workspace default is applied ONLY when the rep has no number.
    expect(src).toMatch(/if \(!callerId && callSettings\?\.default_twilio_number\)/);

    // Fail-safe preserved: never dial from an arbitrary number.
    expect(src).toMatch(/if \(!callerId\)[\s\S]{0,600}<Hangup\/>/);
  });

  it("telFallbackSurvives — the mobile tel: dialer path still exists", () => {
    // C2 replaces this with a bridge. Until then it is the ONLY way a phone
    // can place a call; removing it would leave phones with no calling at all.
    expect(existsSync(path.join(ROOT, "src/lib/outreachDeepLinks.ts"))).toBe(true);
    expect(read("src/lib/outreachDeepLinks.ts")).toMatch(/return `tel:\$\{cleanPhone\(phone\)\}`/);
    expect(existsSync(path.join(ROOT, "src/lib/repCallerNumber.ts"))).toBe(true);
  });
});

describe("C1 — the paid functions are not open to the world", () => {
  const paid: Array<[string, () => string]> = [
    ["call-ingest-recording", callIngest],
    ["call-transcribe", callTranscribe],
    ["call-analyze", callAnalyze],
  ];

  it.each(paid)("paidFunctionsAuthenticated — %s gates its caller", (_name, src) => {
    const body = stripComments(src());
    expect(body).toMatch(/authorizeCallJobCaller\(/);
    // The gate runs before any work: it returns the rejection immediately.
    expect(body).toMatch(/const denied = await authorizeCallJobCaller\([\s\S]{0,120}?\n\s*if \(denied\) return denied;/);
  });

  it("the gate rejects an unauthenticated caller and still admits both real callers", () => {
    const src = stripComments(callConfig());
    const gate = /export async function authorizeCallJobCaller\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
    expect(gate).toBeTruthy();

    // 1. internal-secret / service-role (our own pipeline) → allowed.
    expect(gate).toMatch(/requireAuth\(req, corsHeaders\)/);
    expect(gate).toMatch(/if \(auth\.isPrivileged\) return null;/);
    // 2. a rep's JWT → allowed only for their own workspace's session.
    expect(gate).toMatch(/assertCallSessionAccess\(/);
    // 3. anything else → requireAuth already returned a 401 Response.
    expect(gate).toMatch(/if \(auth instanceof Response\) return auth;/);

    // The rep-facing Retry buttons send a user JWT — they must keep working.
    expect(read("src/pages/CallDetail.tsx")).toMatch(/authSession\.access_token/);
  });
});

describe("C1 — inbound recording-consent settings", () => {
  // QA HOLD #2: an exact string match on the dialled number silently drops the
  // press-1 DTMF consent gate whenever the stored number is formatted
  // differently — in a two-party-consent state that is a compliance gap.
  it("consentSettingsNormalisedMatch — the number match is normalised, not a raw string compare", () => {
    const src = stripComments(voiceInbound());
    // No raw string equality against the dialled number.
    expect(src).not.toMatch(/\.eq\("default_twilio_number", toNumber\)/);
    // The shared, normalised matcher is used instead.
    expect(src).toMatch(/resolveWorkspaceByAgentNumber\(supabase, toNumber\)/);

    // ...and that matcher normalises BOTH sides through one definition.
    const pm = stripComments(phoneMapping());
    expect(pm).toMatch(/export function normalizeE164\(/);
    expect(pm).toMatch(/export function matchWorkspaceByNumber\(/);
    expect(pm).toMatch(/normalizeE164\(r\.default_twilio_number\) === target/);
    // resolvePhoneMapping uses the same matcher — one rule, not two.
    expect(pm).toMatch(/result\.workspaceId = await resolveWorkspaceByAgentNumber\(/);
  });

  it("consentSettingsWorkspaceFallback — settings are workspace-scoped, defaults only when no workspace", () => {
    const src = stripComments(voiceInbound());

    // Fallback 2: an existing call_sessions row for this CallSid.
    const numberMatch = src.indexOf("resolveWorkspaceByAgentNumber(supabase, toNumber)");
    const sessionFallback = src.indexOf('.eq("call_sid", params.CallSid)');
    expect(numberMatch).toBeGreaterThan(-1);
    expect(sessionFallback).toBeGreaterThan(numberMatch);

    // The settings row is always fetched BY WORKSPACE, never unscoped.
    expect(src).toMatch(
      /\.from\("call_settings"\)\s*\.select\("recording_notice_enabled, recording_require_dtmf_consent"\)\s*\.eq\("workspace_id", settingsWorkspaceId\)/,
    );
    // Whatever the workspace says about DTMF consent is what is honoured...
    expect(src).toMatch(/settings\?\.recording_require_dtmf_consent \?\? CALL_DEFAULTS\.RECORDING_REQUIRE_DTMF_CONSENT/);
    // ...and CALL_DEFAULTS is reached ONLY on the no-workspace branch, loudly.
    expect(src).toMatch(/} else \{\s*logger\.error\("inbound_call_settings_no_workspace"/);
  });
});

describe("C1 — transcription language", () => {
  it("hebrewAlternativeLanguages — Google gets alternatives, and he-IL falls back to English", () => {
    const asr = stripComments(asrProvider());
    expect(asr).toMatch(/config\.alternativeLanguageCodes = alternativeLanguageCodes/);
    // Google rejects the primary appearing in the alternatives, and caps at 3.
    expect(asr).toMatch(/\.filter\(\(lang\) => Boolean\(lang\) && lang !== language\)/);
    expect(asr).toMatch(/\.slice\(0, 3\)/);

    const config = stripComments(callConfig());
    // FOUNDER DECISION: he-IL primary → en-US alternative. Everyone else keeps
    // their configured supported_languages untouched.
    expect(config).toMatch(/"he-IL":\s*\["en-US"\]/);
    expect(config).toMatch(/LANGUAGE_ALTERNATIVES\[primary\]/);
    // The default set for non-Hebrew workspaces is unchanged.
    expect(config).toMatch(/SUPPORTED_LANGUAGES:\s*\["en-US", "es-US", "fr-CA"\]/);
    // Alternatives come from LANGUAGE_ALTERNATIVES, else ONLY from an explicitly
    // configured list — never from the shipped default (QA HOLD #3).
    expect(config).toMatch(/hasExplicitLanguages\(supportedLanguages\) \? supportedLanguages! : \[\]/);

    // call-transcribe actually uses the resolver.
    const transcribe = stripComments(callTranscribe());
    expect(transcribe).toMatch(/resolveAsrLanguages\(/);
    expect(transcribe).toMatch(/allowedLanguages:\s*alternativeLangs/);
  });

  // QA HOLD #3: an English-only workspace that never configured languages must
  // get EXACTLY the single-language request it got before this unit. Handing
  // Google the shipped es-US/fr-CA default would let a dealership's English
  // calls come back partly transcribed as Spanish or French.
  it("englishOnlyWorkspaceUnchanged — the shipped default list yields no alternatives", () => {
    const config = stripComments(callConfig());
    const fn = /function hasExplicitLanguages\([\s\S]*?\n}\n/.exec(config)?.[0] ?? "";
    expect(fn).toBeTruthy();
    // A list equal to the shipped default counts as UNconfigured.
    expect(fn).toMatch(/CALL_DEFAULTS\.SUPPORTED_LANGUAGES/);
    expect(fn).toMatch(/return !sameAsShipped;/);

    // And the ASR provider only attaches the field when the list is non-empty,
    // so an empty alternatives list means no alternativeLanguageCodes at all.
    const asr = stripComments(asrProvider());
    expect(asr).toMatch(/alternativeLanguageCodes\.length > 0/);
  });
});

describe("C1 — tenant isolation and lost recordings", () => {
  it("noSingleWorkspaceFallback — phoneMapping never guesses a workspace", () => {
    const src = stripComments(phoneMapping());
    // The leak was: `else if (settings.length === 1) { use settings[0] }`.
    expect(src).not.toMatch(/settings\.length === 1/);
    expect(src).not.toMatch(/result\.workspaceId = settings\[0\]/);
    // Fail closed instead.
    expect(src).toMatch(/if \(!result\.workspaceId\)[\s\S]{0,200}return result;/);
    // Every lead lookup is workspace-scoped — no unscoped `.in("phone", ...)`.
    const leadQueries = src.match(/\.from\("leads"\)[\s\S]{0,300}?\.limit\(1\)/g) ?? [];
    expect(leadQueries.length).toBeGreaterThan(0);
    for (const q of leadQueries) expect(q).toMatch(/\.eq\("workspace_id"/);
  });

  it("twilio-voice-inbound never loads call_settings unscoped", () => {
    const src = stripComments(voiceInbound());
    // The original bug: `.select("*").limit(1)` — whichever row came first.
    expect(src).not.toMatch(/\.from\("call_settings"\)\s*\.select\("\*"\)\s*\.limit\(1\)/);
    // Every call_settings read in this file is keyed on a workspace id.
    const reads = src.match(/\.from\("call_settings"\)[\s\S]{0,300}?\.maybeSingle\(\)/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r).toMatch(/\.eq\("workspace_id"/);
  });

  it("an early recording callback creates a stub session instead of being dropped", () => {
    const src = stripComments(voiceWebhook());
    expect(src).toMatch(/async function findOrStubCallSession\(/);
    expect(src).toMatch(/const session = await findOrStubCallSession\(supabase, params\);/);
    // The stub still resolves its workspace properly — no guessing.
    expect(src).toMatch(/if \(!mapping\.workspaceId\)[\s\S]{0,200}return null;/);
    // Race with the status callback resolves to a re-select, not a crash.
    expect(src).toMatch(/if \(error\.code === "23505"\) return await selectByCallSid\(\);/);
  });
});

describe("C1 — retention and removals", () => {
  const MIGRATION = "supabase/migrations/20260908150000_purge_call_media.sql";

  it("purgeJobDisabled — the purge job is created but shipped OFF", () => {
    expect(existsSync(path.join(ROOT, MIGRATION))).toBe(true);
    const sql = read(MIGRATION);

    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.purge_call_media\(\)/);
    expect(sql).toMatch(/cron\.schedule\(\s*\n?\s*'call-media-purge'/);

    // The last word on the job's state is active = false.
    const disable = sql.lastIndexOf("SET active = false WHERE jobname = 'call-media-purge'");
    expect(disable).toBeGreaterThan(-1);
    expect(sql.slice(disable)).not.toMatch(/SET active = true/);

    // Retention comes from the per-workspace setting that used to be read by
    // nothing at all.
    expect(sql).toMatch(/audio_retention_days/);
  });

  it("CLAUDE.md says the purge is off rather than claiming a 90-day purge happens", () => {
    const claude = read("CLAUDE.md");
    expect(claude).toMatch(/call-media-purge/);
    expect(claude).toMatch(/active = false/);
    expect(claude).not.toMatch(/\*\*Call audio \+ transcripts auto-purge after 90 days\*\*/);
  });

  it("twilio-voice-outbound is gone (deliberately removed)", () => {
    expect(existsSync(path.join(ROOT, `${FN}/twilio-voice-outbound`))).toBe(false);
  });
});
