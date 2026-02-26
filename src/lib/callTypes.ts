// ============================================================
// Call Channel — Frontend config, types, and query helpers
// ============================================================

export const CALL_DEFAULTS = {
  TRANSCRIBE_MIN_DURATION_SEC: 10,
  ANALYZE_MIN_DURATION_SEC: 30,
  DEFAULT_LANGUAGE: "en-US",
  SUPPORTED_LANGUAGES: ["en-US", "es-US", "fr-CA"] as const,
  RECORDING_NOTICE_ENABLED: true,
  RECORDING_REQUIRE_DTMF_CONSENT: false,
  AUDIO_RETENTION_DAYS: 90,
} as const;

// ---- Evidence pointer (Phase 4: timestamp + speaker based) ----
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

// ---- Phase 4: Structured signal types ----
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

// ---- Full structured analysis output ----
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

// ---- Legacy compat: Signal type (used in older code paths) ----
export interface Signal {
  type: string;
  value: string;
  evidence: EvidencePointer[];
}

// ---- DB row types ----
export interface CallSession {
  id: string;
  workspace_id: string;
  call_sid: string;
  direction: "inbound" | "outbound";
  from_number: string;
  to_number: string;
  status: string;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  agent_user_id: string | null;
  customer_contact_id: string | null;
  lead_id: string | null;
  recording_consent_mode: string;
  created_at: string;
  updated_at: string;
}

export interface CallRecording {
  id: string;
  call_session_id: string;
  recording_sid: string;
  twilio_recording_url: string | null;
  duration_sec: number | null;
  channels: number;
  format: string;
  downloaded_at: string | null;
  storage_url: string | null;
  storage_path: string | null;
  storage_provider: string;
  sha256: string | null;
  status: string;
  created_at: string;
}

export interface CallTranscript {
  id: string;
  call_session_id: string;
  provider: string;
  language: string;
  confidence: number | null;
  segments_json: TranscriptSegment[];
  full_text: string | null;
  raw_full_text: string | null;
  clean_full_text: string | null;
  llm_formatted_text: string | null;
  status: string;
  created_at: string;
}

export interface CallAnalysis {
  id: string;
  call_session_id: string;
  status: string;
  model: string | null;
  version: string | null;
  summary_short: string | null;
  summary_long: string | null;
  action_items_json: ActionItem[];
  signals_json: CallAnalysisOutput | Record<string, unknown>;
  recommended_next_steps_json: RecommendedNextStep[];
  created_at: string;
}

export interface FullCallSession {
  session: CallSession;
  recordings: CallRecording[];
  transcripts: CallTranscript[];
  analyses: CallAnalysis[];
}
