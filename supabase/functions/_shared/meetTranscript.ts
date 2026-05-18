// ============================================================
// GoogleMeetClient — Google Meet REST API v2 transcript client
//
// Given an OAuth access token with scope
//   https://www.googleapis.com/auth/meetings.space.readonly
// resolves a meeting code to the transcript entries of the
// conference that overlapped the calendar event's time window.
//
// "Most recent ended conference" is wrong when the same Meet link
// is reused for a later meeting — a backfill/retry for an older
// event would then pick up the wrong conference's transcript.
//
// Pure HTTP wrapper: caller supplies the access token. No token
// lookup, refresh, or DB calls happen here. Expected non-ready
// outcomes (no recording, still processing, not organizer, etc.)
// are returned as a discriminated-union result; only true
// programmer errors throw.
// ============================================================

const MEET_BASE = "https://meet.googleapis.com/v2";

export type MeetTranscriptEntry = {
  speaker: string;
  text: string;
  startTime: string;
  endTime: string;
};

export type MeetPendingReason =
  | "CONFERENCE_NOT_ENDED"
  | "TRANSCRIPT_STILL_PROCESSING";

export type MeetUnavailableReason =
  | "NO_TRANSCRIPT_AVAILABLE"
  | "NOT_ORGANIZER";

export type MeetFailedReason =
  | "TOKEN_INVALID"
  | "PERMISSION_DENIED"
  | "SPACE_NOT_FOUND"
  | "NETWORK_ERROR"
  | "UNKNOWN_ERROR";

export type MeetTranscriptResult =
  | {
      status: "ready";
      providerMeetingId: string;
      transcriptName: string;
      entries: MeetTranscriptEntry[];
    }
  | { status: "pending"; reason: MeetPendingReason }
  | { status: "unavailable"; reason: MeetUnavailableReason }
  | { status: "failed"; reason: MeetFailedReason; detail?: string };

export interface MeetEventWindow {
  // ISO timestamps from calendar_events. `endTime` is null when the event
  // hasn't ended yet — callers in that state should not be fetching a
  // transcript anyway, but we accept it and fall back to most-recent.
  startTime: string | null;
  endTime: string | null;
}

// A meeting can start a little early or run a little long; allow some
// slack on both sides when matching a conference to a calendar event.
const CONFERENCE_MATCH_BUFFER_MS = 30 * 60 * 1000;

type ConferenceRecord = {
  name: string;
  startTime?: string;
  endTime?: string;
  space?: string;
};

type Transcript = {
  name: string;
  state?: string;
  startTime?: string;
  endTime?: string;
};

type TranscriptEntryApi = {
  name?: string;
  participant?: string;
  text?: string;
  startTime?: string;
  endTime?: string;
  languageCode?: string;
};

type ApiStage = "space" | "conferences" | "transcripts" | "entries";

class MeetHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly stage: ApiStage,
  ) {
    super(`Meet API ${stage} failed (${status})`);
    this.name = "MeetHttpError";
  }
}

/**
 * Thin client over the Google Meet REST API v2. Construct with a
 * fresh OAuth access token already scoped to meetings.space.readonly.
 */
export class GoogleMeetClient {
  constructor(private readonly accessToken: string) {}

  /**
   * Resolves a meeting code (e.g. "mnr-xxxx-xxx") to the transcript
   * entries of the conference that overlapped the given event window.
   * When the same Meet link is reused for multiple meetings, the window
   * lets us pick the right conference instead of the most recent one.
   * Returns a discriminated-union result; does not throw on expected
   * "no transcript" outcomes.
   */
  async fetchTranscriptForMeetingCode(
    meetingCode: string,
    eventWindow: MeetEventWindow,
  ): Promise<MeetTranscriptResult> {
    if (!meetingCode || typeof meetingCode !== "string") {
      throw new Error("meetingCode must be a non-empty string");
    }

    try {
      const spaceName = await this.resolveSpaceName(meetingCode);

      const records = await this.listConferenceRecords(spaceName);
      const endedRecord = pickConferenceForWindow(records, eventWindow);
      if (!endedRecord) {
        return { status: "pending", reason: "CONFERENCE_NOT_ENDED" };
      }

      const transcripts = await this.listTranscripts(endedRecord.name);
      if (transcripts.length === 0) {
        return { status: "unavailable", reason: "NO_TRANSCRIPT_AVAILABLE" };
      }

      // Stopping + restarting transcription in the same conference creates
      // multiple transcript resources. Wait until every session has reached
      // FILE_GENERATED — otherwise we'd mark the row 'ready' with a partial
      // transcript and the analyzer would run against incomplete text.
      const ready = transcripts.filter((t) => t.state === "FILE_GENERATED");
      if (ready.length === 0 || ready.length < transcripts.length) {
        return { status: "pending", reason: "TRANSCRIPT_STILL_PROCESSING" };
      }

      // Concatenate in start-time order so speakers appear in chronological
      // sequence across stop/restart boundaries.
      ready.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));

      const entries: MeetTranscriptEntry[] = [];
      for (const t of ready) {
        const chunk = await this.listAllTranscriptEntries(t.name);
        entries.push(...chunk);
      }

      return {
        status: "ready",
        providerMeetingId: endedRecord.name,
        transcriptName: ready.map((t) => t.name).join(","),
        entries,
      };
    } catch (err) {
      if (err instanceof MeetHttpError) {
        return mapHttpError(err);
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.warn("meet.transcript.fetch_failed", { meetingCode, error: detail });
      return { status: "failed", reason: "NETWORK_ERROR", detail };
    }
  }

  // ---- private helpers ----

  private async getJson<T>(url: string, stage: ApiStage): Promise<T> {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new MeetHttpError(resp.status, body, stage);
    }
    return (await resp.json()) as T;
  }

  private async resolveSpaceName(meetingCode: string): Promise<string> {
    const url = `${MEET_BASE}/spaces/${encodeURIComponent(meetingCode)}`;
    const space = await this.getJson<{ name?: string }>(url, "space");
    if (!space?.name) {
      throw new MeetHttpError(0, "space response missing name", "space");
    }
    return space.name;
  }

  private async listConferenceRecords(
    spaceName: string,
  ): Promise<ConferenceRecord[]> {
    const params = new URLSearchParams({
      filter: `space.name="${spaceName}"`,
      orderBy: "start_time desc",
    });
    const url = `${MEET_BASE}/conferenceRecords?${params.toString()}`;
    const resp = await this.getJson<{ conferenceRecords?: ConferenceRecord[] }>(
      url,
      "conferences",
    );
    return resp.conferenceRecords ?? [];
  }

  private async listTranscripts(
    conferenceRecordName: string,
  ): Promise<Transcript[]> {
    const url = `${MEET_BASE}/${conferenceRecordName}/transcripts`;
    const resp = await this.getJson<{ transcripts?: Transcript[] }>(
      url,
      "transcripts",
    );
    return resp.transcripts ?? [];
  }

  private async listAllTranscriptEntries(
    transcriptName: string,
  ): Promise<MeetTranscriptEntry[]> {
    const out: MeetTranscriptEntry[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ pageSize: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const url = `${MEET_BASE}/${transcriptName}/entries?${params.toString()}`;
      const resp = await this.getJson<{
        transcriptEntries?: TranscriptEntryApi[];
        nextPageToken?: string;
      }>(url, "entries");
      for (const e of resp.transcriptEntries ?? []) {
        out.push({
          speaker: e.participant ?? "",
          text: e.text ?? "",
          startTime: e.startTime ?? "",
          endTime: e.endTime ?? "",
        });
      }
      pageToken = resp.nextPageToken;
    } while (pageToken);
    return out;
  }
}

// Returns the ended conference whose start time falls inside the calendar
// event's window (with a buffer for early/late starts). Falls back to the
// most recent ended conference only when the caller didn't supply usable
// bounds — never when bounds are present but nothing matches.
function pickConferenceForWindow(
  records: ConferenceRecord[],
  eventWindow: MeetEventWindow,
): ConferenceRecord | null {
  const ended = records.filter((r) => !!r.endTime);
  if (ended.length === 0) return null;

  const eventStart = eventWindow.startTime
    ? new Date(eventWindow.startTime).getTime()
    : Number.NaN;
  const eventEnd = eventWindow.endTime
    ? new Date(eventWindow.endTime).getTime()
    : Number.NaN;

  // Without parseable bounds, preserve the previous "most recent ended"
  // behavior. Callers always pass real timestamps in production; this
  // branch exists for tests and future callers that genuinely have none.
  if (Number.isNaN(eventStart) || Number.isNaN(eventEnd)) {
    return ended[0];
  }

  for (const r of ended) {
    if (!r.startTime) continue;
    const t = new Date(r.startTime).getTime();
    if (Number.isNaN(t)) continue;
    if (
      t >= eventStart - CONFERENCE_MATCH_BUFFER_MS &&
      t <= eventEnd + CONFERENCE_MATCH_BUFFER_MS
    ) {
      return r;
    }
  }

  // Nothing overlaps the event window — could be the meeting was cancelled,
  // or the Meet link will only be used later. Return null and let the
  // caller treat it as pending; the 24h sweep eventually marks unavailable.
  return null;
}

function mapHttpError(err: MeetHttpError): MeetTranscriptResult {
  const snippet = err.body.slice(0, 300);

  if (err.status === 401) {
    return { status: "failed", reason: "TOKEN_INVALID" };
  }
  if (err.status === 403) {
    if (/organizer/i.test(err.body)) {
      return { status: "unavailable", reason: "NOT_ORGANIZER" };
    }
    return { status: "failed", reason: "PERMISSION_DENIED", detail: snippet };
  }
  if (err.status === 404 && err.stage === "space") {
    return { status: "failed", reason: "SPACE_NOT_FOUND" };
  }
  return {
    status: "failed",
    reason: "UNKNOWN_ERROR",
    detail: `${err.stage} HTTP ${err.status}: ${snippet}`,
  };
}
