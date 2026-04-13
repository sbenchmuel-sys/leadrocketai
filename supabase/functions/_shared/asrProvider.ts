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

  constructor(apiKey: string, model = "google/gemini-2.5-flash") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async transcribe(audioBase64: string, options: AsrOptions): Promise<AsrResult> {
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

    // Try multiple content formats — gateway compatibility varies
    const contentFormats = [
      // Format 1: OpenAI-style image_url with audio data URI
      [
        { type: "image_url", image_url: { url: `data:audio/wav;base64,${audioBase64}` } },
        { type: "text", text: prompt },
      ],
      // Format 2: input_audio (OpenAI native)
      [
        { type: "input_audio", input_audio: { data: audioBase64, format: "wav" } },
        { type: "text", text: prompt },
      ],
    ];

    let lastError = "";

    for (const content of contentFormats) {
      try {
        const resp = await fetch("https://api.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "user", content }],
            temperature: 0.1,
          }),
        });

        if (!resp.ok) {
          lastError = await resp.text();
          logger.warn("asr_format_attempt_failed", { status: resp.status, error: lastError.slice(0, 200) });
          continue; // Try next format
        }

        const result = await resp.json();
        const resultContent = result.choices?.[0]?.message?.content ?? "";

        let parsed: { segments?: AsrSegment[]; fullText?: string; confidence?: number; language?: string };
        try {
          const jsonMatch = resultContent.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
        } catch {
          parsed = { fullText: resultContent, segments: [], confidence: undefined };
        }

        return {
          language: parsed.language ?? options.language ?? "en-US",
          confidence: parsed.confidence,
          segments: parsed.segments ?? [],
          fullText: parsed.fullText ?? resultContent,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn("asr_format_attempt_exception", { error: lastError });
        continue;
      }
    }

    // All formats failed
    logger.error("gemini_asr_all_formats_failed", { error: lastError.slice(0, 500) });
    throw new Error(`Gemini ASR failed with all content formats: ${lastError.slice(0, 200)}`);
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
