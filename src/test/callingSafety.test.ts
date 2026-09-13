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

  // P1: a user removed from the workspace keeps their auth account and their
  // rep_profiles row (with its twilio_phone_number), and twilio-voice-token
  // issues a Voice token to any authenticated user. Guarding on the caller ID
  // alone therefore let them dial out on the workspace's Twilio account — and
  // with resolvedWorkspaceId null the call_sessions insert was skipped, so the
  // call was unbilled, unlogged and invisible to the admin who removed them.
  //
  // Source-text guard, not behavioural: twilio-voice-inbound is a Deno module
  // vitest cannot import. The behaviour of the helper it calls is executed by
  // supabase/functions/_shared/callSafety.test.ts in the Deno suite.
  it("removedUserCannotDial — outbound needs a membership AND a caller ID", () => {
    const src = stripComments(voiceInbound());

    // The guard runs on the browser/outbound branch, before any TwiML that dials.
    const guard = src.indexOf("denyBrowserOutbound(");
    const dial = src.indexOf("buildOutboundDialTwiml(");
    expect(guard).toBeGreaterThan(-1);
    expect(dial).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dial);

    // Both inputs are passed — a guard given only the caller ID is the bug.
    expect(src).toMatch(
      /denyBrowserOutbound\(\{\s*workspaceId:\s*resolvedWorkspaceId,\s*callerId,/,
    );

    // And it returns before dialling, speaking a refusal rather than nothing.
    expect(src).toMatch(/if \(denial\)[\s\S]{0,400}browserOutboundDenialTwiml\(denial\)/);

    // The old caller-ID-only guard is gone.
    expect(src).not.toMatch(/if \(!callerId\) \{/);

    // The session row stays keyed on the resolved workspace, which the guard now
    // guarantees — so a dialled browser call always leaves an audit row.
    expect(src).toMatch(/if \(resolvedWorkspaceId && callSid\)/);
  });

  // P1 #2, same doorway: rep_profiles.twilio_phone_number is free text the user
  // types into their OWN profile (RepProfileCard → upsertRepProfile), validated
  // by nothing, on a schema where rep_profiles has no workspace column. All
  // tenants share one Twilio account, so workspace B's number typed into an
  // A-member's profile dialled out as B with the session row saying A.
  //
  // Source-text guard (the behaviour of denyBrowserOutbound and
  // workspacesClaimingNumber is executed in the Deno suite).
  it("foreignCallerIdRefused — the caller ID is checked against the resolved workspace", () => {
    const src = stripComments(voiceInbound());

    // The claim list is resolved from call_settings and fed to the same guard.
    expect(src).toMatch(/resolveWorkspacesClaimingNumber\(supabase, callerId\)/);
    expect(src).toMatch(/denyBrowserOutbound\(\{[\s\S]{0,200}callerIdWorkspaceIds,?\s*\}\)/);

    // Resolved BEFORE the guard, which is before the dial.
    const claims = src.indexOf("resolveWorkspacesClaimingNumber(");
    const guard = src.indexOf("denyBrowserOutbound(");
    const dial = src.indexOf("buildOutboundDialTwiml(");
    expect(claims).toBeGreaterThan(-1);
    expect(claims).toBeLessThan(guard);
    expect(guard).toBeLessThan(dial);

    // The rule itself: claimed by someone else → refuse; claimed by us, or by
    // nobody, → allow. (Shared-number tenants must not lock each other out.)
    expect(callConfig()).toMatch(
      /if \(claims\.length > 0 && !claims\.includes\(args\.workspaceId\)\) return "foreign_caller_id";/,
    );

    // A third distinct spoken reason, not a reuse of an existing one.
    expect(callConfig()).toMatch(/reason === "foreign_caller_id"/);
    expect(callConfig()).toMatch(/registered to a different workspace/);
  });

  it("removedUserCannotDial — the inbound PSTN path is NOT gated by it", () => {
    const src = stripComments(voiceInbound());
    // The guard must sit inside the browser branch: an inbound caller is not an
    // authenticated user and has no membership, so gating them would kill every
    // incoming call.
    const browserBranch = src.indexOf("if (isBrowserCall && clientToNumber)");
    const inboundFlow = src.indexOf("const toNumber = params.To");
    const guard = src.indexOf("denyBrowserOutbound(");
    expect(browserBranch).toBeGreaterThan(-1);
    expect(inboundFlow).toBeGreaterThan(browserBranch);
    expect(guard).toBeGreaterThan(browserBranch);
    expect(guard).toBeLessThan(inboundFlow);
    // Only one call site — the refusal cannot leak onto another branch.
    expect(src.match(/denyBrowserOutbound\(/g) ?? []).toHaveLength(1);
  });

  // The first version of this fix put a <Say> before <Dial>. That plays on the
  // REP's Twilio Client leg, before the number is even dialled — the prospect
  // heard nothing and was still recorded without notice. A test that only
  // checked "a <Say> exists somewhere" PASSED on that broken version, so this
  // one pins the LEG the notice lands on.
  it("outboundRecordingNotice — the notice rides the callee leg, not the rep's", () => {
    const src = callConfig();
    const dialDoc = /export function buildOutboundDialTwiml\([\s\S]*?\n}\n/.exec(src)?.[0] ?? "";
    expect(dialDoc).toBeTruthy();

    // 1. The rep's document must contain NO <Say> at all. This is the assertion
    //    that fails on the broken version.
    expect(dialDoc).not.toMatch(/<Say/);

    // 2. The notice is delivered by a `url` on <Number>, which Twilio fetches on
    //    the CALLED party's leg after they answer and before bridging.
    const numberTag = /<Number[^>]*>/.exec(dialDoc)?.[0] ?? "";
    expect(numberTag).toBeTruthy();
    expect(numberTag).toMatch(/\$\{noticeAttr\}|noticeAttr/);
    expect(dialDoc).toMatch(/noticeAttr\s*=\s*args\.recordingNotice[\s\S]{0,160}url="\$\{escapeXml\(args\.calleeNoticeUrl\)\}"/);

    // 3. The thing that URL returns is the actual spoken notice.
    const noticeDoc = /export function buildCalleeNoticeTwiml\([\s\S]*?\n}\n/.exec(src)?.[0] ?? "";
    expect(noticeDoc).toMatch(/<Say[^>]*>\$\{RECORDING_NOTICE_TEXT\}<\/Say>/);
    expect(src).toMatch(/RECORDING_NOTICE_TEXT\s*=\s*\n?\s*"This call may be recorded/);

    // 4. The outbound leg really is recording, so the notice is not decorative.
    expect(dialDoc).toMatch(/record="record-from-answer-dual"/);

    // 5. twilio-voice-inbound builds through the builder and supplies the URL.
    const inbound = stripComments(voiceInbound());
    expect(inbound).toMatch(/buildOutboundDialTwiml\(\{/);
    expect(inbound).toMatch(/calleeNoticeUrl:\s*calleeNoticeUrl\(fnUrl\)/);
  });

  it("calleeNoticeBranchIsSignatureValidated — the notice endpoint is not open", () => {
    const src = stripComments(voiceInbound());
    // The branch that speaks must sit AFTER signature validation, like every
    // other branch — an open TwiML endpoint lets anyone make the workspace's
    // Twilio account talk.
    const sigCheck = src.indexOf("validateTwilioSignature(");
    const noticeBranch = src.indexOf("buildCalleeNoticeTwiml()");
    expect(sigCheck).toBeGreaterThan(-1);
    expect(noticeBranch).toBeGreaterThan(sigCheck);

    // Twilio signs the full URL INCLUDING the query string. If this regressed to
    // the bare function URL, the ?leg=callee_notice fetch would 403 and Twilio
    // would drop the prospect's leg mid-dial — so it is load-bearing.
    expect(src).toMatch(/const incomingQuery = new URL\(req\.url\)\.search;/);
    expect(src).toMatch(/const publicUrl = `\$\{fnUrl\}\$\{incomingQuery\}`;/);
  });

  it("repCallerNumberPreferred — the rep's own number wins over the workspace default", () => {
    const src = stripComments(voiceInbound());
    const repLookup = src.indexOf('.from("rep_profiles")');
    const wsDefault = src.indexOf("default_twilio_number");
    expect(repLookup).toBeGreaterThan(-1);
    expect(wsDefault).toBeGreaterThan(repLookup);

    // The workspace default is applied ONLY when the rep has no number.
    expect(src).toMatch(/if \(!callerId && callSettings\?\.default_twilio_number\)/);

    // Fail-safe preserved: never dial from an arbitrary number. The check moved
    // into denyBrowserOutbound when the membership requirement was added (it now
    // refuses on "no_caller_id"), so assert the guard still gates the dial.
    expect(src).toMatch(/denyBrowserOutbound\([\s\S]{0,400}browserOutboundDenialTwiml\(denial\)/);
    expect(callConfig()).toMatch(/if \(!args\.callerId\) return "no_caller_id";/);
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

  // NOTE: these are source-text guards over the migration, not behavioural
  // tests — the purge is pure SQL and no Postgres is reachable from the unit
  // suite. They fail if the analyses purge stops clearing one of the three
  // quote-bearing columns, or stops selecting rows by all three.
  it("the analyses purge clears every column that holds verbatim transcript quotes", () => {
    const sql = read(MIGRATION);

    // call-analyze writes all three; all three must be cleared in one UPDATE.
    const update = sql.slice(sql.indexOf("UPDATE public.call_analyses"));
    expect(update).toMatch(/SET signals_json = '\{\}'::jsonb/);
    expect(update).toMatch(/action_items_json = public\.strip_call_evidence\(a\.action_items_json\)/);
    expect(update).toMatch(
      /recommended_next_steps_json = public\.strip_call_evidence\(a\.recommended_next_steps_json\)/,
    );

    // Eligibility covers all three, so a row already emptied of signals_json by
    // the earlier signals-only predicate is still revisited and finished off.
    const predicate = update.slice(update.indexOf("WHERE"), update.indexOf("RETURNING"));
    expect(predicate).toMatch(/signals_json <> '\{\}'::jsonb/);
    expect(predicate).toMatch(/strip_call_evidence\(a\.action_items_json\) IS DISTINCT FROM a\.action_items_json/);
    expect(predicate).toMatch(
      /strip_call_evidence\(a\.recommended_next_steps_json\)\s*\n?\s*IS DISTINCT FROM a\.recommended_next_steps_json/,
    );

    // The durable paraphrases are NOT touched (same rule as the email purge).
    expect(update).not.toMatch(/summary_short/);
    expect(update).not.toMatch(/summary_long/);
  });

  it("strip_call_evidence removes only the evidence arrays, and is re-runnable", () => {
    const sql = read(MIGRATION);
    const fn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.strip_call_evidence"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.purge_call_media"),
    );
    expect(fn).toMatch(/IMMUTABLE/);
    // Only the `evidence` key is dropped — text/owner/priority/rank/rationale stay.
    expect(fn).toMatch(/elem - 'evidence'/);
    expect(fn.match(/ - '/g) ?? []).toHaveLength(1);
    // Non-array / NULL input is returned unchanged, so a second run is a no-op.
    expect(fn).toMatch(/WHEN jsonb_typeof\(p_items\) <> 'array' THEN p_items/);
  });

  it("the purge migration carries no production project ref", () => {
    expect(read(MIGRATION)).not.toMatch(/ntzeiflqqluwgdfmatjh/);
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
