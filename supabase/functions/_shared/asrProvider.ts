// ===========================================================
// ASR Provider Abstraction — Multi-strategy audio transcription
// ===========================================================
import { logger } from "./logger.ts";

// ---- Interfaces ----

export interface AsrSegment {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
}

export interface AsrResult {
  language: string;
  confidence?: number;
  segments: AsrSegment[];
  fullText: string;
}

export interface AsrOptions {
  language?: string;
  autoDetect?: boolean;
  allowedLanguages?: string[];
  diarization: boolean;
  timestamps: boolean;
}

export interface AsrProvider {
  transcribe(audioBase64: string, options: AsrOptions): Promise<AsrResult>;
}

// ---- Twilio Transcription Provider ----
// Uses Twilio Intelligence / basic transcription via recording SID

export class TwilioAsrProvider implements AsrProvider {
  private accountSid: string;
  private authToken: string;
  private recordingSid: string;

  constructor(accountSid: string, authToken: string, recordingSid: string) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.recordingSid = recordingSid;
  }

  async transcribe(_audioBase64: string, options: AsrOptions): Promise<AsrResult> {
    // Use Twilio's Transcription API to create a transcription from the recording
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Recordings/${this.recordingSid}/Transcriptions.json`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.warn("twilio_transcription_create_failed", { status: resp.status, error: errText.slice(0, 300) });
      
      // Fallback: download the recording directly from Twilio and try LLM-based transcription
      return this.fallbackDirectDownload(options);
    }

    const txResult = await resp.json();
    logger.info("twilio_transcription_created", { sid: txResult.sid, status: txResult.status });

    // Twilio transcription is async — poll for completion
    const transcriptionSid = txResult.sid;
    const maxWait = 120_000; // 2 minutes
    const pollInterval = 5_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));

      const statusUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Recordings/${this.recordingSid}/Transcriptions/${transcriptionSid}.json`;
      const statusResp = await fetch(statusUrl, {
        headers: {
          Authorization: `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`,
        },
      });

      if (!statusResp.ok) continue;

      const statusData = await statusResp.json();
      if (statusData.status === "completed") {
        return {
          language: options.language ?? "en-US",
          confidence: undefined,
          segments: [{
            startMs: 0,
            endMs: (statusData.duration || 0) * 1000,
            speaker: "Speaker 1",
            text: statusData.transcription_text || "",
          }],
          fullText: statusData.transcription_text || "",
        };
      } else if (statusData.status === "failed") {
        logger.error("twilio_transcription_failed", { sid: transcriptionSid });
        return this.fallbackDirectDownload(options);
      }
    }

    logger.warn("twilio_transcription_timeout", { sid: transcriptionSid });
    return this.fallbackDirectDownload(options);
  }

  /** Fallback: Download recording audio from Twilio and return raw text via LLM */
  private async fallbackDirectDownload(options: AsrOptions): Promise<AsrResult> {
    // Try to get the recording audio directly from Twilio
    const audioUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Recordings/${this.recordingSid}.wav`;
    const audioResp = await fetch(audioUrl, {
      headers: {
        Authorization: `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`,
      },
    });

    if (!audioResp.ok) {
      throw new Error(`Failed to download recording from Twilio: ${audioResp.status}`);
    }

    // We have the audio but no way to transcribe it without an LLM that supports audio
    // Return a placeholder that indicates manual transcription is needed
    throw new Error("Twilio basic transcription unavailable — no audio-capable LLM configured");
  }
}

// ---- Gemini ASR Provider (for when gateway supports audio) ----

export class GeminiAsrProvider implements AsrProvider {
  private apiKey: string;
  private model: string;
  private twilioFallback?: TwilioAsrProvider;

  constructor(apiKey: string, model = "google/gemini-2.5-flash") {
    this.apiKey = apiKey;
    this.model = model;
  }

  /** Configure Twilio fallback for when the LLM gateway doesn't support audio */
  setTwilioFallback(accountSid: string, authToken: string, recordingSid: string) {
    this.twilioFallback = new TwilioAsrProvider(accountSid, authToken, recordingSid);
  }

  async transcribe(audioBase64: string, options: AsrOptions): Promise<AsrResult> {
    // Strategy 1: Try LLM gateway with audio (may not be supported)
    try {
      const result = await this.tryLlmAudio(audioBase64, options);
      if (result) return result;
    } catch (err) {
      logger.warn("llm_audio_failed", { error: err instanceof Error ? err.message : String(err) });
    }

    // Strategy 2: Twilio native transcription
    if (this.twilioFallback) {
      try {
        const result = await this.twilioFallback.transcribe(audioBase64, options);
        logger.info("twilio_fallback_success");
        return result;
      } catch (err) {
        logger.warn("twilio_fallback_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    throw new Error("All ASR strategies failed — no audio transcription service available");
  }

  private async tryLlmAudio(audioBase64: string, options: AsrOptions): Promise<AsrResult | null> {
    const langInstruction = options.autoDetect && options.allowedLanguages?.length
      ? `Auto-detect the language from these options: ${options.allowedLanguages.join(", ")}. Report detected language in BCP-47 format.`
      : `Transcribe in ${options.language ?? "en-US"}.`;

    const prompt = `${langInstruction}
Return JSON ONLY with this exact structure:
{
  "segments": [
    {"startMs": 0, "endMs": 5000, "speaker": "Speaker 1", "text": "..."},
    {"startMs": 5000, "endMs": 10000, "speaker": "Speaker 2", "text": "..."}
  ],
  "fullText": "complete transcript as single string",
  "confidence": 0.95,
  "language": "en-US"
}
${options.diarization ? "Identify and label different speakers consistently." : ""}
${options.timestamps ? "Provide accurate timestamps in milliseconds." : ""}
Return valid JSON only, no markdown fences.`;

    // Try input_audio format
    const resp = await fetch("https://api.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: audioBase64, format: "wav" } },
            { type: "text", text: prompt },
          ],
        }],
        temperature: 0.1,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.warn("llm_audio_api_error", { status: resp.status, error: errText.slice(0, 200) });
      return null;
    }

    const result = await resp.json();
    const content = result.choices?.[0]?.message?.content ?? "";

    let parsed: { segments?: AsrSegment[]; fullText?: string; confidence?: number; language?: string };
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      parsed = { fullText: content, segments: [], confidence: undefined };
    }

    return {
      language: parsed.language ?? options.language ?? "en-US",
      confidence: parsed.confidence,
      segments: parsed.segments ?? [],
      fullText: parsed.fullText ?? content,
    };
  }
}

// ---- Diarization Normalization ----

export function normalizeSpeakerRoles(
  segments: AsrSegment[],
  direction: string,
): AsrSegment[] {
  if (segments.length === 0) return segments;

  const speakerOrder: string[] = [];
  for (const seg of segments) {
    if (!speakerOrder.includes(seg.speaker)) {
      speakerOrder.push(seg.speaker);
    }
  }

  const roleMap = new Map<string, string>();

  if (speakerOrder.length <= 2) {
    if (direction === "outbound") {
      roleMap.set(speakerOrder[0], "Agent");
      if (speakerOrder[1]) roleMap.set(speakerOrder[1], "Customer");
    } else {
      roleMap.set(speakerOrder[0], "Customer");
      if (speakerOrder[1]) roleMap.set(speakerOrder[1], "Agent");
    }
  }

  return segments.map((seg) => ({
    ...seg,
    speaker: roleMap.get(seg.speaker) ?? seg.speaker,
  }));
}

// ---- Transcript Cleanup ----

export function cleanTranscriptText(text: string): string {
  return text
    .replace(/\b(\w+)(?:\s+\1){2,}\b/gi, "$1")
    .replace(/\b(uh|um|ah|er|hmm)(?:\s+\1){1,}\b/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function cleanSegments(segments: AsrSegment[]): AsrSegment[] {
  return segments.map((seg) => ({
    ...seg,
    text: cleanTranscriptText(seg.text),
  }));
}

// ---- LLM-Ready Transcript Formatter ----

export function formatLlmTranscript(segments: AsrSegment[]): string {
  return segments
    .map((seg) => {
      const totalSec = Math.floor(seg.startMs / 1000);
      const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
      const sec = String(totalSec % 60).padStart(2, "0");
      return `[${min}:${sec}] ${seg.speaker}: ${seg.text}`;
    })
    .join("\n");
}
