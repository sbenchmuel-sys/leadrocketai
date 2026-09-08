// ============================================================
// Call Channel — Config defaults & shared types
// ============================================================
import { assertCallSessionAccess, requireAuth } from "./authz.ts";

// authz.ts's helpers take the service-role client; typed loosely here so this
// module does not have to import supabase-js itself.
// ponytail: a structural type instead of the real SupabaseClient. Ceiling — no
// compile-time checking of the query builder; upgrade when _shared gains a
// single shared client type.
// deno-lint-ignore no-explicit-any
type SupabaseClientLike = any;

export const CALL_DEFAULTS = {
  TRANSCRIBE_MIN_DURATION_SEC: 10,
  ANALYZE_MIN_DURATION_SEC: 30,
  DEFAULT_LANGUAGE: "en-US",
  SUPPORTED_LANGUAGES: ["en-US", "es-US", "fr-CA"],
  RECORDING_NOTICE_ENABLED: true,
  RECORDING_REQUIRE_DTMF_CONSENT: false,
  AUDIO_RETENTION_DAYS: 90,
} as const;

/** Google STT accepts at most 3 alternativeLanguageCodes per request. */
const MAX_ALTERNATIVE_LANGUAGES = 3;

/**
 * Hebrew-first workspaces. FOUNDER DECISION recorded on the founder's behalf
 * (C1/7, 2026-09-08): a workspace whose `call_settings.default_language` is
 * `he-IL` transcribes Hebrew-first with English (`en-US`) as the alternative.
 * Every other workspace keeps whatever `supported_languages` it already has —
 * this changes nothing for existing English/Spanish/French workspaces.
 */
export const LANGUAGE_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
  "he-IL": ["en-US"],
};

/**
 * Has this workspace deliberately chosen its language list, or is it just
 * carrying the column's out-of-the-box default?
 *
 * `call_settings.supported_languages` is NOT NULL DEFAULT
 * ARRAY['en-US','es-US','fr-CA'], so every workspace row is non-empty and
 * "non-empty" cannot mean "configured". A row matching the shipped default is
 * treated as unconfigured.
 *
 * ponytail: a workspace that deliberately types the exact default set is
 * indistinguishable from one that never touched it, and gets no alternatives.
 * Ceiling: no "configured at" marker on the column. Upgrade path is a nullable
 * `supported_languages` (NULL = untouched) or a separate opt-in flag.
 */
function hasExplicitLanguages(list: readonly string[] | null | undefined): boolean {
  if (!list || list.length === 0) return false;
  const shipped = CALL_DEFAULTS.SUPPORTED_LANGUAGES as readonly string[];
  const sameAsShipped = list.length === shipped.length && shipped.every((l) => list.includes(l));
  return !sameAsShipped;
}

/**
 * Resolve the primary ASR language and the alternatives Google should also try.
 *
 * Before this existed, `call-transcribe` sent ONE `languageCode` and no
 * alternatives, so a Hebrew call on an `en-US` workspace came back as English
 * gibberish (C1/7).
 *
 * Alternatives are sent in exactly two cases, and NO others:
 *   1. the primary has a defined alternative (he-IL → en-US);
 *   2. the workspace has EXPLICITLY configured extra languages.
 * An out-of-the-box English workspace gets an EMPTY alternatives list — byte for
 * byte the single-language request it got before this unit. Handing Google the
 * shipped es-US/fr-CA default would let an English-only dealership's calls come
 * back partly transcribed as Spanish or French, which is a regression, not a fix.
 */
export function resolveAsrLanguages(
  defaultLanguage: string | null | undefined,
  supportedLanguages: readonly string[] | null | undefined,
): { primary: string; alternatives: string[] } {
  const primary = defaultLanguage || CALL_DEFAULTS.DEFAULT_LANGUAGE;

  const source = LANGUAGE_ALTERNATIVES[primary]
    ?? (hasExplicitLanguages(supportedLanguages) ? supportedLanguages! : []);

  const alternatives = Array.from(new Set(source))
    .filter((lang) => Boolean(lang) && lang !== primary)
    .slice(0, MAX_ALTERNATIVE_LANGUAGES);

  return { primary, alternatives };
}

/** Minimal XML escaping for values interpolated into TwiML. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The spoken recording notice. Same wording on the inbound and outbound legs. */
export const RECORDING_NOTICE_TEXT =
  "This call may be recorded for quality and training purposes.";

/**
 * Query marker that turns `twilio-voice-inbound` into the callee-leg notice
 * endpoint. `<Number url="...?leg=callee_notice">` points here.
 *
 * A query STRING (not a separate function) because Twilio must be able to fetch
 * it, and every Twilio-facing URL in this codebase is signature-validated by
 * `twilio-voice-inbound` already. Twilio signs the full URL INCLUDING the query
 * string, so the validator must reconstruct it — see twilio-voice-inbound.
 */
export const CALLEE_NOTICE_PARAM = "leg";
export const CALLEE_NOTICE_VALUE = "callee_notice";

/** Build the callee-leg notice URL from the function's own public URL. */
export function calleeNoticeUrl(functionUrl: string): string {
  return `${functionUrl}?${CALLEE_NOTICE_PARAM}=${CALLEE_NOTICE_VALUE}`;
}

/**
 * TwiML played to the CALLED party (the prospect), on their own leg, after they
 * answer and BEFORE the two legs are bridged. This is what Twilio fetches from
 * the `url` attribute on `<Number>`.
 */
export function buildCalleeNoticeTwiml(): string {
  return `<Response><Say voice="Polly.Joanna">${RECORDING_NOTICE_TEXT}</Say></Response>`;
}

/**
 * TwiML for a browser-originated OUTBOUND call.
 *
 * WHICH LEG HEARS WHAT — this is the whole point, and getting it wrong is why
 * the first version of this fix was rejected:
 *
 *   • This document executes on the REP's Twilio Client leg. A `<Say>` placed
 *     here — as the first version had it, before `<Dial>` — is heard by the REP,
 *     before Twilio has even dialled the `<Number>`. The prospect hears nothing
 *     and is still recorded without notice. There is therefore deliberately NO
 *     `<Say>` in this document.
 *   • The notice rides on the `url` attribute of `<Number>`. Twilio fetches that
 *     URL when the CALLED party answers and plays the returned TwiML on THEIR
 *     leg, before bridging. So the prospect hears the notice before the
 *     conversation starts, and the rep does not sit through it on every call
 *     (the rep hears ringback for the ~3s it takes).
 *
 * `record="record-from-answer-dual"` starts at answer, so the notice is also
 * captured at the head of the recording — useful evidence that it was given.
 */
export function buildOutboundDialTwiml(args: {
  to: string;
  callerId: string;
  statusCallbackUrl: string;
  recordingCallbackUrl: string;
  recordingNotice: boolean;
  /** Where Twilio fetches the callee-leg notice. See `calleeNoticeUrl`. */
  calleeNoticeUrl: string;
}): string {
  // No notice configured → no `url` attribute → straight bridge, as before.
  const noticeAttr = args.recordingNotice
    ? ` url="${escapeXml(args.calleeNoticeUrl)}" method="POST"`
    : "";
  return `<Response>
  <Dial callerId="${escapeXml(args.callerId)}" record="record-from-answer-dual" recordingStatusCallback="${escapeXml(args.recordingCallbackUrl)}" recordingStatusCallbackEvent="completed" recordingChannels="2">
    <Number${noticeAttr} statusCallback="${escapeXml(args.statusCallbackUrl)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${escapeXml(args.to)}</Number>
  </Dial>
</Response>`;
}

/**
 * Auth gate for the three PAID call-pipeline functions
 * (`call-ingest-recording`, `call-transcribe`, `call-analyze`).
 *
 * All three run with `verify_jwt = false` (they are invoked edge-to-edge by
 * `enqueueCallJob`, which cannot present a user JWT). Until C1 they had NO
 * in-function auth either, so anyone who knew the URL could burn Google STT and
 * Gemini credits (C1/6).
 *
 * Two legitimate callers, both preserved:
 *   1. our own pipeline — `enqueueCallJob` sends the service-role Bearer;
 *      `cron`/edge callers may instead send `X-Internal-Secret`.
 *   2. a REP pressing "Retry" on the Call Detail page (`src/pages/CallDetail.tsx`)
 *      — a user JWT, authorised against the call session's workspace.
 * Twilio never calls these three directly; it only calls `twilio-voice-webhook`,
 * which is signature-validated and then fans out via `enqueueCallJob`.
 *
 * Returns a Response to send back on rejection, or null when the caller is allowed.
 */
export async function authorizeCallJobCaller(
  req: Request,
  admin: SupabaseClientLike,
  corsHeaders: Record<string, string>,
  callSessionId: string | null,
): Promise<Response | null> {
  const auth = await requireAuth(req, corsHeaders);
  if (auth instanceof Response) return auth;
  if (auth.isPrivileged) return null;

  // User JWT: must be a member of the workspace that owns this call session.
  if (!callSessionId) {
    return new Response(JSON.stringify({ error: "Missing callSessionId" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const access = await assertCallSessionAccess(admin, callSessionId, auth.userId!);
  if (!access.ok) {
    return new Response(JSON.stringify({ error: access.error ?? "Forbidden" }), {
      status: access.status ?? 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}
