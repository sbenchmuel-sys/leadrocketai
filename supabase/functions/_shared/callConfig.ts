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
