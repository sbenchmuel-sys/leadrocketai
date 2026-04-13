// ===========================================================
// ASR Provider Abstraction — Future-proof audio transcription
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

// ---- Gemini (Default) Provider ----

export class GeminiAsrProvider implements AsrProvider {
  private apiKey: string;
  private model: string;
  private audioUrl?: string; // Optional: signed URL for the audio file

  constructor(apiKey: string, model = "google/gemini-2.5-flash") {
    this.apiKey = apiKey;
    this.model = model;
  }

  /** Set a signed URL for the audio file (preferred over base64) */
  setAudioUrl(url: string) {
    this.audioUrl = url;
  }

  async transcribe(audioBase64: string, options: AsrOptions): Promise<AsrResult> {
    // Strategy 1: Try Whisper-style /v1/audio/transcriptions endpoint
    try {
      const whisperResult = await this.tryWhisperEndpoint(audioBase64, options);
      if (whisperResult) return whisperResult;
    } catch (err) {
      logger.warn("whisper_endpoint_failed", { error: err instanceof Error ? err.message : String(err) });
    }

    // Strategy 2: Try chat completions with audio URL reference (if available)
    if (this.audioUrl) {
      try {
        const urlResult = await this.tryChatWithAudioUrl(options);
        if (urlResult) return urlResult;
      } catch (err) {
        logger.warn("chat_audio_url_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Strategy 3: Try chat completions with inline base64 audio
    try {
      const inlineResult = await this.tryChatWithInlineAudio(audioBase64, options);
      if (inlineResult) return inlineResult;
    } catch (err) {
      logger.warn("chat_inline_audio_failed", { error: err instanceof Error ? err.message : String(err) });
    }

    throw new Error("All ASR strategies failed — audio transcription not supported by current gateway");
  }

  private buildPrompt(options: AsrOptions): string {
    const langInstruction = options.autoDetect && options.allowedLanguages?.length
      ? `Auto-detect the language from these options: ${options.allowedLanguages.join(", ")}. Report detected language in BCP-47 format.`
      : `Transcribe in ${options.language ?? "en-US"}.`;

    return `${langInstruction}
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
  }

  private parseResult(content: string, options: AsrOptions): AsrResult {
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

  /** Whisper-style audio transcription endpoint */
  private async tryWhisperEndpoint(audioBase64: string, options: AsrOptions): Promise<AsrResult | null> {
    // Convert base64 to Blob for form-data
    const binaryStr = atob(audioBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const formData = new FormData();
    formData.append("file", new Blob([bytes], { type: "audio/wav" }), "recording.wav");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");
    if (options.language && !options.autoDetect) {
      formData.append("language", options.language.split("-")[0]); // "en-US" → "en"
    }

    const resp = await fetch("https://api.lovable.dev/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.warn("whisper_api_error", { status: resp.status, error: errText.slice(0, 200) });
      return null;
    }

    const result = await resp.json();
    logger.info("whisper_transcription_success", { language: result.language });

    // Whisper verbose_json includes segments
    const segments: AsrSegment[] = (result.segments || []).map((seg: any, i: number) => ({
      startMs: Math.round((seg.start || 0) * 1000),
      endMs: Math.round((seg.end || 0) * 1000),
      speaker: `Speaker ${i % 2 === 0 ? 1 : 2}`, // Basic alternation — will be normalized later
      text: seg.text?.trim() || "",
    }));

    return {
      language: result.language ? `${result.language}-US` : options.language ?? "en-US",
      confidence: undefined,
      segments,
      fullText: result.text || "",
    };
  }

  /** Chat completions with audio URL reference */
  private async tryChatWithAudioUrl(options: AsrOptions): Promise<AsrResult | null> {
    const prompt = this.buildPrompt(options);
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
            { type: "image_url", image_url: { url: this.audioUrl } },
            { type: "text", text: prompt },
          ],
        }],
        temperature: 0.1,
      }),
    });

    if (!resp.ok) return null;
    const result = await resp.json();
    const content = result.choices?.[0]?.message?.content ?? "";
    return this.parseResult(content, options);
  }

  /** Chat completions with inline base64 audio */
  private async tryChatWithInlineAudio(audioBase64: string, options: AsrOptions): Promise<AsrResult | null> {
    const prompt = this.buildPrompt(options);
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

    if (!resp.ok) return null;
    const result = await resp.json();
    const content = result.choices?.[0]?.message?.content ?? "";
    return this.parseResult(content, options);
  }
}

// ---- Diarization Normalization ----

export function normalizeSpeakerRoles(
  segments: AsrSegment[],
  direction: string,
): AsrSegment[] {
  if (segments.length === 0) return segments;

  // Collect unique speakers in order of first appearance
  const speakerOrder: string[] = [];
  for (const seg of segments) {
    if (!speakerOrder.includes(seg.speaker)) {
      speakerOrder.push(seg.speaker);
    }
  }

  // Build role map
  const roleMap = new Map<string, string>();

  if (speakerOrder.length <= 2) {
    if (direction === "outbound") {
      // Outbound: our agent called, so Speaker 1 = Agent
      roleMap.set(speakerOrder[0], "Agent");
      if (speakerOrder[1]) roleMap.set(speakerOrder[1], "Customer");
    } else {
      // Inbound: caller speaks first = Customer
      roleMap.set(speakerOrder[0], "Customer");
      if (speakerOrder[1]) roleMap.set(speakerOrder[1], "Agent");
    }
  }
  // If >2 speakers, keep originals

  return segments.map((seg) => ({
    ...seg,
    speaker: roleMap.get(seg.speaker) ?? seg.speaker,
  }));
}

// ---- Transcript Cleanup ----

export function cleanTranscriptText(text: string): string {
  return text
    // Collapse repeated words: "I I I" → "I"
    .replace(/\b(\w+)(?:\s+\1){2,}\b/gi, "$1")
    // Collapse repeated fillers: "uh uh uh" → "uh"
    .replace(/\b(uh|um|ah|er|hmm)(?:\s+\1){1,}\b/gi, "$1")
    // Collapse excessive whitespace
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
