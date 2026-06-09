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
  /** Number of ~55s chunks the audio was split into (1 for short single-shot calls). */
  chunkCount?: number;
}

export interface AsrOptions {
  language?: string;
  autoDetect?: boolean;
  allowedLanguages?: string[];
  diarization: boolean;
  timestamps: boolean;
  channelCount?: number;
  /** Absolute epoch-ms deadline; chunked transcription aborts (throws) if exceeded. */
  deadlineMs?: number;
}

export interface AsrProvider {
  transcribe(audioBase64: string, options: AsrOptions): Promise<AsrResult>;
}

function durationStringToMs(value?: string): number {
  if (!value) return 0;
  const normalized = value.endsWith("s") ? value.slice(0, -1) : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : 0;
}

function averageConfidence(values: Array<number | undefined>): number | undefined {
  const valid = values.filter((value): value is number => typeof value === "number" && !Number.isNaN(value));
  if (valid.length === 0) return undefined;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

interface GoogleSpeechWord {
  startTime?: string;
  endTime?: string;
}

interface GoogleSpeechAlternative {
  transcript?: string;
  confidence?: number;
  words?: GoogleSpeechWord[];
}

interface GoogleSpeechResult {
  alternatives?: GoogleSpeechAlternative[];
  channelTag?: number;
  languageCode?: string;
  resultEndTime?: string;
}

// ---- WAV audio chunking utilities ----

interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

function parseWavHeader(buffer: ArrayBuffer): WavInfo {
  const view = new DataView(buffer);
  // Find "fmt " chunk
  let offset = 12; // skip RIFF header
  let sampleRate = 8000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = 44;
  let dataSize = buffer.byteLength - 44;

  while (offset < buffer.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }

  return { sampleRate, channels, bitsPerSample, dataOffset, dataSize };
}

function buildWavChunk(
  originalBuffer: ArrayBuffer,
  info: WavInfo,
  pcmStart: number,
  pcmLength: number,
): ArrayBuffer {
  const headerSize = 44;
  const wavBuffer = new ArrayBuffer(headerSize + pcmLength);
  const view = new DataView(wavBuffer);
  const bytesPerSec = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  const blockAlign = info.channels * (info.bitsPerSample / 8);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + pcmLength, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, info.channels, true);
  view.setUint32(24, info.sampleRate, true);
  view.setUint32(28, bytesPerSec, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, info.bitsPerSample, true);
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, pcmLength, true);

  const src = new Uint8Array(originalBuffer, info.dataOffset + pcmStart, pcmLength);
  new Uint8Array(wavBuffer, headerSize).set(src);
  return wavBuffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class GoogleSpeechAsrProvider implements AsrProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(audioBase64: string, options: AsrOptions): Promise<AsrResult> {
    // Back-compat entry point: decode base64 to a raw WAV buffer, then delegate.
    const binaryString = atob(audioBase64);
    const rawBuffer = new ArrayBuffer(binaryString.length);
    const rawView = new Uint8Array(rawBuffer);
    for (let i = 0; i < binaryString.length; i++) rawView[i] = binaryString.charCodeAt(i);
    return this.transcribeBuffer(rawBuffer, options);
  }

  /**
   * Preferred entry point. Transcribes directly from a raw WAV ArrayBuffer so the
   * caller never has to hold a full-file base64 copy in memory — only each ~55s
   * chunk is base64-encoded per Google request, keeping peak memory bounded.
   */
  async transcribeBuffer(rawBuffer: ArrayBuffer, options: AsrOptions): Promise<AsrResult> {
    const wavInfo = parseWavHeader(rawBuffer);
    const bytesPerSec = wavInfo.sampleRate * wavInfo.channels * (wavInfo.bitsPerSample / 8);
    const totalDurationSec = wavInfo.dataSize / bytesPerSec;

    const CHUNK_DURATION_SEC = 55; // stay under 60s limit

    const preferredLanguages = Array.from(new Set([
      options.language,
      ...(options.allowedLanguages ?? []),
    ].filter((v): v is string => Boolean(v))));
    const [primaryLanguage = "en-US"] = preferredLanguages;

    if (totalDurationSec <= 59) {
      // Short enough for a single synchronous recognize call
      const result = await this.recognizeSync(arrayBufferToBase64(rawBuffer), primaryLanguage, options, 0);
      return { ...result, chunkCount: 1 };
    }

    // Chunk the audio and transcribe each chunk
    const numChunks = Math.ceil(totalDurationSec / CHUNK_DURATION_SEC);
    logger.info("audio_chunking", { totalDurationSec, chunkDuration: CHUNK_DURATION_SEC, chunks: numChunks });

    const allSegments: AsrSegment[] = [];
    const confidences: (number | undefined)[] = [];
    let detectedLang = primaryLanguage;

    for (let i = 0; i < numChunks; i++) {
      // Abort cleanly (caller marks the transcript failed) if we run out of wall-clock budget.
      if (options.deadlineMs && Date.now() >= options.deadlineMs) {
        throw new Error(`Transcription deadline exceeded after ${i}/${numChunks} chunks`);
      }
      const startSec = i * CHUNK_DURATION_SEC;
      const pcmStart = Math.floor(startSec * bytesPerSec);
      const pcmLength = Math.min(
        Math.floor(CHUNK_DURATION_SEC * bytesPerSec),
        wavInfo.dataSize - pcmStart,
      );
      if (pcmLength <= 0) break;

      const chunkBuf = buildWavChunk(rawBuffer, wavInfo, pcmStart, pcmLength);
      const chunkB64 = arrayBufferToBase64(chunkBuf);
      const offsetMs = startSec * 1000;

      const result = await this.recognizeSync(chunkB64, primaryLanguage, options, offsetMs);
      allSegments.push(...result.segments);
      confidences.push(result.confidence);
      if (result.language !== primaryLanguage) detectedLang = result.language;
    }

    return {
      language: detectedLang,
      confidence: averageConfidence(confidences),
      segments: allSegments.sort((a, b) => a.startMs - b.startMs),
      fullText: allSegments.map((s) => s.text).join(" ").trim(),
      chunkCount: numChunks,
    };
  }

  private async recognizeSync(
    audioBase64: string,
    language: string,
    options: AsrOptions,
    offsetMs: number,
  ): Promise<AsrResult> {
    const config: Record<string, unknown> = {
      languageCode: language,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      model: "latest_long",
      useEnhanced: true,
    };

    if ((options.channelCount ?? 1) > 1) {
      config.audioChannelCount = options.channelCount;
      config.enableSeparateRecognitionPerChannel = true;
    } else if (options.diarization) {
      config.diarizationConfig = {
        enableSpeakerDiarization: true,
        minSpeakerCount: 2,
        maxSpeakerCount: 2,
      };
    }

    const resp = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config,
        audio: { content: audioBase64 },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Google Speech recognize failed: ${resp.status} ${errText.slice(0, 300)}`);
    }

    const data = await resp.json();
    const results = (data.results ?? []) as GoogleSpeechResult[];
    const parsed = this.parseResults(results, language, offsetMs);
    return parsed;
  }

  private parseResults(results: GoogleSpeechResult[], fallbackLanguage: string, offsetMs = 0): AsrResult {
    const segments: AsrSegment[] = results
      .map((result) => {
        const alternative = result.alternatives?.[0];
        const transcript = alternative?.transcript?.trim();
        if (!transcript) return null;

        const words = alternative.words ?? [];
        const startMs = durationStringToMs(words[0]?.startTime) + offsetMs;
        const endMs = (durationStringToMs(words[words.length - 1]?.endTime) || durationStringToMs(result.resultEndTime)) + offsetMs;

        return {
          startMs,
          endMs: endMs > startMs ? endMs : startMs,
          speaker: result.channelTag ? `Speaker ${result.channelTag}` : "Speaker 1",
          text: transcript,
        } satisfies AsrSegment;
      })
      .filter((segment): segment is AsrSegment => Boolean(segment))
      .sort((a, b) => a.startMs - b.startMs);

    const confidences = results.map((result) => result.alternatives?.[0]?.confidence);
    const detectedLanguage = results.find((result) => result.languageCode)?.languageCode ?? fallbackLanguage;

    return {
      language: detectedLanguage,
      confidence: averageConfidence(confidences),
      segments,
      fullText: segments.map((segment) => segment.text).join(" ").trim(),
    };
  }
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

  // Prefer API Key auth for outbound REST; fall back to Account SID:Auth Token.
  // Account SID stays in the URL path (Accounts/${this.accountSid}/...) either way.
  private get authHeader(): string {
    const apiKey = Deno.env.get("TWILIO_API_KEY");
    const apiSecret = Deno.env.get("TWILIO_API_SECRET");
    return apiKey && apiSecret
      ? `Basic ${btoa(`${apiKey}:${apiSecret}`)}`
      : `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`;
  }

  async transcribe(_audioBase64: string, options: AsrOptions): Promise<AsrResult> {
    // Use Twilio's Transcription API to create a transcription from the recording
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Recordings/${this.recordingSid}/Transcriptions.json`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
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
          Authorization: this.authHeader,
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
        Authorization: this.authHeader,
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
