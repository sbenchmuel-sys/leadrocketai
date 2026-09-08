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
 * Resolve the primary ASR language and the alternatives Google should also try.
 *
 * Before this existed, `call-transcribe` sent ONE `languageCode` and no
 * alternatives, so a Hebrew call on an `en-US` workspace came back as English
 * gibberish (C1/7).
 */
export function resolveAsrLanguages(
  defaultLanguage: string | null | undefined,
  supportedLanguages: readonly string[] | null | undefined,
): { primary: string; alternatives: string[] } {
  const primary = defaultLanguage || CALL_DEFAULTS.DEFAULT_LANGUAGE;
  const configured = supportedLanguages && supportedLanguages.length > 0
    ? supportedLanguages
    : CALL_DEFAULTS.SUPPORTED_LANGUAGES;
  const source = LANGUAGE_ALTERNATIVES[primary] ?? configured;

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
 * TwiML for a browser-originated OUTBOUND call.
 *
 * The `<Say>` recording notice is a PUBLIC LEGAL COMMITMENT, not decoration:
 * the outbound leg records with `record-from-answer-dual` exactly like the
 * inbound leg, and until C1 the outbound leg said nothing at all. It is emitted
 * BEFORE `<Dial>` so the callee hears it as the call connects.
 */
export function buildOutboundDialTwiml(args: {
  to: string;
  callerId: string;
  statusCallbackUrl: string;
  recordingCallbackUrl: string;
  recordingNotice: boolean;
}): string {
  const notice = args.recordingNotice
    ? `\n  <Say voice="Polly.Joanna">${RECORDING_NOTICE_TEXT}</Say>`
    : "";
  return `<Response>${notice}
  <Dial callerId="${escapeXml(args.callerId)}" record="record-from-answer-dual" recordingStatusCallback="${escapeXml(args.recordingCallbackUrl)}" recordingStatusCallbackEvent="completed" recordingChannels="2">
    <Number statusCallback="${escapeXml(args.statusCallbackUrl)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${escapeXml(args.to)}</Number>
  </Dial>
</Response>`;
}

// ---- Twilio Status values ----
export type TwilioCallStatus =
  | "initiated"
  | "ringing"
  | "in-progress"
  | "completed"
  | "failed"
  | "busy"
  | "no-answer"
  | "canceled";

// Map Twilio status → our internal status
export function mapTwilioStatus(twStatus: string): string {
  const map: Record<string, string> = {
    "initiated": "initiated",
    "ringing": "ringing",
    "in-progress": "answered",
    "completed": "completed",
    "failed": "failed",
    "busy": "busy",
    "no-answer": "no-answer",
    "canceled": "canceled",
  };
  return map[twStatus] ?? twStatus;
}

// ---- Evidence pointer (Phase 4: timestamp + speaker) ----
export interface EvidencePointer {
  timestamp: string; // "MM:SS"
  speaker: "Agent" | "Customer" | string;
  quote: string;
}

// ---- Transcript segment ----
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speaker: string;
  label?: string;
  text: string;
}

// ---- Phase 4: Structured analysis output ----
export interface CallOutcome {
  label: "positive" | "neutral" | "negative" | "no_outcome";
  confidence: number;
}

export interface CallIntent {
  type: "buying" | "support" | "complaint" | "renewal" | "churn_risk" | "other";
  confidence: number;
  evidence: EvidencePointer[];
}

export interface SentimentTimelineEntry {
  minute: number;
  sentiment: "positive" | "neutral" | "negative";
}

export interface CallSentiment {
  overall: "positive" | "neutral" | "negative";
  confidence: number;
  timeline: SentimentTimelineEntry[];
}

export interface CallObjection {
  type: "price" | "timing" | "security" | "feature_gap" | "trust" | "other";
  severity: "low" | "medium" | "high";
  evidence: EvidencePointer[];
}

export interface CallCommitment {
  who: "Agent" | "Customer";
  text: string;
  dueDate: string | null;
  evidence: EvidencePointer[];
}

export interface CallRisk {
  type: "churn" | "legal" | "escalation" | "no_next_step" | "other";
  severity: "low" | "medium" | "high";
  evidence: EvidencePointer[];
}

export interface ActionItem {
  text: string;
  owner: "Agent" | "Internal" | "Customer";
  priority: "low" | "medium" | "high";
  evidence: EvidencePointer[];
}

export interface RecommendedNextStep {
  rank: number;
  text: string;
  rationale: string;
  confidence: number;
  evidence: EvidencePointer[];
}

export interface CallAnalysisOutput {
  summaryShort: string;
  summaryLong: string;
  outcome: CallOutcome;
  intent: CallIntent;
  sentiment: CallSentiment;
  objections: CallObjection[];
  commitments: CallCommitment[];
  risks: CallRisk[];
  actionItems: ActionItem[];
  recommendedNextSteps: RecommendedNextStep[];
}

// ---- Job interface ----
export interface CallJob {
  type: "ingest_recording" | "transcribe_call" | "analyze_call";
  callSessionId: string;
  recordingId?: string;
}

export async function enqueueCallJob(job: CallJob): Promise<void> {
  const fnMap: Record<CallJob["type"], string> = {
    ingest_recording: "call-ingest-recording",
    transcribe_call: "call-transcribe",
    analyze_call: "call-analyze",
  };

  const fnName = fnMap[job.type];
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const resp = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(job),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[enqueueCallJob] Failed to invoke ${fnName}: ${resp.status} ${text}`);
  } else {
    await resp.text(); // consume body
  }
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
