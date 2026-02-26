// ============================================================
// Call Channel — Config defaults & shared types
// ============================================================

export const CALL_DEFAULTS = {
  TRANSCRIBE_MIN_DURATION_SEC: 10,
  ANALYZE_MIN_DURATION_SEC: 30,
  DEFAULT_LANGUAGE: "en-US",
  SUPPORTED_LANGUAGES: ["en-US", "es-US", "fr-CA"],
  RECORDING_NOTICE_ENABLED: true,
  RECORDING_REQUIRE_DTMF_CONSENT: false,
  AUDIO_RETENTION_DAYS: 90,
} as const;

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

// ---- Evidence pointer (used in analysis outputs) ----
export interface EvidencePointer {
  segmentIndex?: number;
  timestampRangeMs?: [number, number];
  speakerLabel?: string;
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

// ---- Analysis structures ----
export interface ActionItem {
  text: string;
  owner?: string;
  dueDate?: string;
  evidence: EvidencePointer[];
}

export interface Signal {
  type: string; // intent | sentiment | objection | risk | commitment | entity
  value: string;
  evidence: EvidencePointer[];
}

export interface RecommendedNextStep {
  title: string;
  rationale: string;
  priority: number;
  evidence: EvidencePointer[];
}

// ---- Job interface ----
export interface CallJob {
  type: "ingest_recording" | "transcribe_call" | "analyze_call";
  callSessionId: string;
  recordingId?: string;
}

export async function enqueueCallJob(job: CallJob): Promise<void> {
  // Synchronous fallback: directly invoke the relevant edge function
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
