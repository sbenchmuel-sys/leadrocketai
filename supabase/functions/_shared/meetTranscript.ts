// ============================================================
// GoogleMeetClient — Google Meet REST API v2 transcript client
//
// Given an OAuth access token with scope
//   https://www.googleapis.com/auth/meetings.space.readonly
// resolves a meeting code to the transcript entries of the most
// recent ended conference in that space.
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
   * entries of the most recent ended conference in that space.
   * Returns a discriminated-union result; does not throw on expected
   * "no transcript" outcomes.
   */
  async fetchTranscriptForMeetingCode(
    meetingCode: string,
  ): Promise<MeetTranscriptResult> {
    if (!meetingCode || typeof meetingCode !== "string") {
      throw new Error("meetingCode must be a non-empty string");
    }

    try {
      const spaceName = await this.resolveSpaceName(meetingCode);

      const records = await this.listConferenceRecords(spaceName);
      const endedRecord = pickMostRecentEnded(records);
      if (!endedRecord) {
        return { status: "pending", reason: "CONFERENCE_NOT_ENDED" };
      }

      const transcripts = await this.listTranscripts(endedRecord.name);
      if (transcripts.length === 0) {
        return { status: "unavailable", reason: "NO_TRANSCRIPT_AVAILABLE" };
      }
      const fileGenerated = transcripts.find((t) => t.state === "FILE_GENERATED");
      if (!fileGenerated) {
        return { status: "pending", reason: "TRANSCRIPT_STILL_PROCESSING" };
      }

      const entries = await this.listAllTranscriptEntries(fileGenerated.name);
      return {
        status: "ready",
        providerMeetingId: endedRecord.name,
        transcriptName: fileGenerated.name,
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

function pickMostRecentEnded(
  records: ConferenceRecord[],
): ConferenceRecord | null {
  return records.find((r) => !!r.endTime) ?? null;
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
