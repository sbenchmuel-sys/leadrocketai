// ============================================================
// TeamsGraphClient — Microsoft Graph transcript client
//
// Given an OAuth access token with scope
//   OnlineMeetingTranscript.Read.All (+ OnlineMeetings.Read)
// resolves a Teams meeting joinWebUrl to the VTT transcript that
// corresponds to the calendar event with the supplied end time.
//
// Pure HTTP wrapper: caller supplies the access token. No token
// lookup, refresh, or DB calls happen here. Expected non-ready
// outcomes (no transcript, meeting not found, not organizer) are
// returned as a discriminated-union result. Programmer errors and
// repeated Graph 5xx throw — the caller decides whether to persist
// or surface a 500.
//
// Recurring-series note: a Teams series shares one joinWebUrl
// across all occurrences, so the meeting's /transcripts list may
// contain one entry per occurrence. We pick the transcript whose
// `createdDateTime` is closest to the calendar event's end time.
// (Graph's transcript resource does not expose endDateTime — the
// transcript is created shortly after the meeting ends, so
// createdDateTime is the documented proxy.)
// ============================================================

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MAX_TRANSCRIPT_TIME_DRIFT_MS = 60 * 60 * 1000; // 60 min

export type TeamsUnavailableReason =
  | "NO_TRANSCRIPT_AVAILABLE"
  | "MEETING_NOT_FOUND"
  | "NOT_ORGANIZER";

export type TeamsFailedReason = "UNKNOWN_ERROR";

export type TeamsTranscriptResult =
  | {
      status: "ready";
      onlineMeetingId: string;
      transcriptId: string;
      vtt: string;
    }
  | { status: "unavailable"; reason: TeamsUnavailableReason }
  | { status: "failed"; reason: TeamsFailedReason; detail?: string };

type GraphOnlineMeeting = {
  id?: string;
  joinWebUrl?: string;
};

type GraphTranscript = {
  id?: string;
  meetingId?: string;
  createdDateTime?: string;
};

type ApiStage = "resolve_meeting" | "list_transcripts" | "fetch_content";

class TeamsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly stage: ApiStage,
  ) {
    super(`Teams Graph ${stage} failed (${status})`);
    this.name = "TeamsHttpError";
  }
}

/**
 * Thin client over Microsoft Graph v1.0 for fetching Teams meeting
 * transcripts. Construct with a fresh OAuth access token already
 * scoped to OnlineMeetingTranscript.Read.All + OnlineMeetings.Read.
 */
export class TeamsGraphClient {
  constructor(private readonly accessToken: string) {}

  /**
   * Resolves a Teams meeting joinWebUrl to the VTT transcript whose
   * createdDateTime is closest to `eventEndTimeIso`. Returns a
   * discriminated-union result; throws only on programmer errors
   * or repeated Graph 5xx.
   */
  async fetchTranscriptForJoinUrl(
    joinWebUrl: string,
    eventEndTimeIso: string,
  ): Promise<TeamsTranscriptResult> {
    if (!joinWebUrl || typeof joinWebUrl !== "string") {
      throw new Error("joinWebUrl must be a non-empty string");
    }
    if (!eventEndTimeIso || typeof eventEndTimeIso !== "string") {
      throw new Error("eventEndTimeIso must be a non-empty ISO string");
    }
    const eventEndMs = Date.parse(eventEndTimeIso);
    if (Number.isNaN(eventEndMs)) {
      throw new Error(`eventEndTimeIso is not a valid date: ${eventEndTimeIso}`);
    }

    try {
      const onlineMeetingId = await this.resolveOnlineMeetingId(joinWebUrl);
      if (!onlineMeetingId) {
        return { status: "unavailable", reason: "MEETING_NOT_FOUND" };
      }

      const transcripts = await this.listTranscripts(onlineMeetingId);
      if (transcripts.length === 0) {
        return { status: "unavailable", reason: "NO_TRANSCRIPT_AVAILABLE" };
      }

      const picked = pickClosestTranscript(transcripts, eventEndMs);
      if (!picked) {
        return { status: "unavailable", reason: "NO_TRANSCRIPT_AVAILABLE" };
      }

      const vtt = await this.fetchTranscriptContent(onlineMeetingId, picked.id!);
      return {
        status: "ready",
        onlineMeetingId,
        transcriptId: picked.id!,
        vtt,
      };
    } catch (err) {
      if (err instanceof TeamsHttpError) {
        if (err.status >= 500) throw err;
        return mapHttpError(err);
      }
      throw err;
    }
  }

  // ---- private helpers ----

  private async resolveOnlineMeetingId(
    joinWebUrl: string,
  ): Promise<string | null> {
    // OData filter: single-quote literals require doubling embedded quotes.
    const escaped = joinWebUrl.replace(/'/g, "''");
    const filterExpr = `JoinWebUrl eq '${escaped}'`;
    const url = `${GRAPH_BASE}/me/onlineMeetings?$filter=${encodeURIComponent(filterExpr)}`;
    const resp = await this.getJson<{ value?: GraphOnlineMeeting[] }>(
      url,
      "resolve_meeting",
    );
    const first = resp.value?.[0];
    return first?.id ?? null;
  }

  private async listTranscripts(
    onlineMeetingId: string,
  ): Promise<GraphTranscript[]> {
    const url = `${GRAPH_BASE}/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts`;
    const resp = await this.getJson<{ value?: GraphTranscript[] }>(
      url,
      "list_transcripts",
    );
    return (resp.value ?? []).filter((t) => !!t.id);
  }

  private async fetchTranscriptContent(
    onlineMeetingId: string,
    transcriptId: string,
  ): Promise<string> {
    const url =
      `${GRAPH_BASE}/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}` +
      `/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`;
    const text = await this.getText(url, "fetch_content");
    return text;
  }

  private async getJson<T>(url: string, stage: ApiStage): Promise<T> {
    const resp = await this.fetchWith5xxRetry(url, stage);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new TeamsHttpError(resp.status, body, stage);
    }
    return (await resp.json()) as T;
  }

  private async getText(url: string, stage: ApiStage): Promise<string> {
    const resp = await this.fetchWith5xxRetry(url, stage);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new TeamsHttpError(resp.status, body, stage);
    }
    return resp.text();
  }

  // One automatic retry on 5xx. A second 5xx propagates as
  // TeamsHttpError and is re-thrown by fetchTranscriptForJoinUrl
  // — the contract is "5xx → throw after one retry".
  private async fetchWith5xxRetry(
    url: string,
    stage: ApiStage,
  ): Promise<Response> {
    const first = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (first.status < 500) return first;
    const second = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (second.status < 500) return second;
    const body = await second.text().catch(() => "");
    throw new TeamsHttpError(second.status, body, stage);
  }
}

function pickClosestTranscript(
  transcripts: GraphTranscript[],
  eventEndMs: number,
): GraphTranscript | null {
  let bestDriftMs = Number.POSITIVE_INFINITY;
  let best: GraphTranscript | null = null;
  for (const t of transcripts) {
    if (!t.createdDateTime) continue;
    const ms = Date.parse(t.createdDateTime);
    if (Number.isNaN(ms)) continue;
    const drift = Math.abs(ms - eventEndMs);
    if (drift < bestDriftMs) {
      bestDriftMs = drift;
      best = t;
    }
  }
  if (!best || bestDriftMs > MAX_TRANSCRIPT_TIME_DRIFT_MS) return null;
  return best;
}

function mapHttpError(err: TeamsHttpError): TeamsTranscriptResult {
  const snippet = err.body.slice(0, 300);
  if (err.status === 403) {
    return { status: "unavailable", reason: "NOT_ORGANIZER" };
  }
  if (err.status === 404 && err.stage === "resolve_meeting") {
    return { status: "unavailable", reason: "MEETING_NOT_FOUND" };
  }
  return {
    status: "failed",
    reason: "UNKNOWN_ERROR",
    detail: `${err.stage} HTTP ${err.status}: ${snippet}`,
  };
}
