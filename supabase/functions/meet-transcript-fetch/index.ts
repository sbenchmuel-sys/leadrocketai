// ============================================================
// meet-transcript-fetch
//
// Per-meeting transcript fetcher. Called by other internal edge
// functions (e.g. the Phase-2 poller) — never by a user, never by
// cron-dispatcher. Single-meeting scope: one calendar_event_id
// per invocation.
//
// Auth: privileged callers only (X-Internal-Secret or service-role
// bearer). Anonymous and user JWTs are rejected.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeDecryptToken, encryptToken } from "../_shared/encryption.ts";
import { requirePrivilegedCaller } from "../_shared/authz.ts";
import { projectTimelineItem } from "../_shared/timelineProjector.ts";
import { GoogleMeetClient, type MeetTranscriptResult } from "../_shared/meetTranscript.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface CalendarEventRow {
  id: string;
  user_id: string;
  workspace_id: string;
  lead_id: string | null;
  platform: string | null;
  meeting_url: string | null;
  raw_event: Record<string, unknown> | null;
}

interface GmailConnectionRow {
  user_id: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string;
}

interface TranscriptRow {
  id: string;
  status: string;
  fetch_attempts: number | null;
}

class InvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGrantError";
  }
}

function extractMeetingCode(ev: CalendarEventRow): string | null {
  // deno-lint-ignore no-explicit-any
  const conferenceId = (ev.raw_event as any)?.conferenceData?.conferenceId;
  if (typeof conferenceId === "string" && conferenceId.trim().length > 0) {
    return conferenceId.trim();
  }
  if (ev.meeting_url) {
    try {
      const u = new URL(ev.meeting_url);
      const segments = u.pathname.split("/").filter(Boolean);
      const tail = segments[segments.length - 1];
      if (tail && tail.length > 0) return tail;
    } catch {
      // fall through
    }
  }
  return null;
}

// Mirrors the refresh pattern in supabase/functions/gmail-send/index.ts.
// Decrypts the stored tokens, refreshes if within 5 min of expiry, persists
// the new (re-encrypted) access token. Throws InvalidGrantError if the
// refresh response indicates the grant has been revoked.
// deno-lint-ignore no-explicit-any
async function refreshTokenIfNeeded(
  supabase: any,
  connection: GmailConnectionRow,
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();

  const rawAccessToken = connection.access_token_encrypted ?? "";
  const rawRefreshToken = connection.refresh_token_encrypted ?? "";
  const decryptedAccessToken = await safeDecryptToken(rawAccessToken);
  const decryptedRefreshToken = await safeDecryptToken(rawRefreshToken);

  if (expiresAt.getTime() - now.getTime() >= 5 * 60 * 1000) {
    return decryptedAccessToken;
  }

  const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: decryptedRefreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (errorBody.includes("invalid_grant")) {
      throw new InvalidGrantError("Google refresh token revoked (invalid_grant)");
    }
    throw new Error(`Failed to refresh token: ${response.status}`);
  }

  const tokens = await response.json();
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  let encryptedNewAccessToken = tokens.access_token;
  try {
    const hasEncryptionKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
    if (hasEncryptionKey) {
      encryptedNewAccessToken = await encryptToken(tokens.access_token);
    }
  } catch (encryptError) {
    console.error(
      "[meet-transcript-fetch] Token encryption failed, storing plaintext:",
      encryptError,
    );
  }

  await supabase
    .from("gmail_connections")
    .update({
      access_token_encrypted: encryptedNewAccessToken,
      token_expires_at: newExpiresAt,
    })
    .eq("user_id", connection.user_id);

  return tokens.access_token as string;
}

// Insert-or-update meeting_transcripts to the given status without touching
// transcript_text / transcript_format / provider_meeting_id / ready_at.
// Increments fetch_attempts only when transitioning into 'fetching' or
// 'failed' via this path. Returns the row id.
async function upsertTranscriptRow(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  ev: CalendarEventRow,
  existing: TranscriptRow | null,
  status: "fetching" | "failed",
  statusReason: string | null,
  providerErrorDetail: string | null,
): Promise<string> {
  const nowIso = new Date().toISOString();
  if (existing) {
    const nextAttempts = (existing.fetch_attempts ?? 0) + 1;
    const { data, error } = await supabase
      .from("meeting_transcripts")
      .update({
        status,
        status_reason: statusReason,
        provider_error_detail: providerErrorDetail,
        last_attempt_at: nowIso,
        fetch_attempts: nextAttempts,
      })
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`meeting_transcripts update failed: ${error?.message ?? "no row"}`);
    }
    return data.id as string;
  }

  const { data, error } = await supabase
    .from("meeting_transcripts")
    .insert({
      workspace_id: ev.workspace_id,
      calendar_event_id: ev.id,
      lead_id: ev.lead_id,
      provider: "google_meet",
      status,
      status_reason: statusReason,
      provider_error_detail: providerErrorDetail,
      fetch_attempts: 1,
      last_attempt_at: nowIso,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`meeting_transcripts insert failed: ${error?.message ?? "no row"}`);
  }
  return data.id as string;
}

function resultReason(result: MeetTranscriptResult): string | null {
  if (result.status === "ready") return null;
  return result.reason;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const gateResp = requirePrivilegedCaller(req, corsHeaders);
  if (gateResp) return gateResp;

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  let parsedBody: { calendarEventId?: unknown } = {};
  try {
    parsedBody = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const calendarEventId = parsedBody?.calendarEventId;
  if (typeof calendarEventId !== "string" || calendarEventId.length === 0) {
    return jsonResponse(400, {
      ok: false,
      error: "calendarEventId is required and must be a non-empty string",
    });
  }
  if (!UUID_RE.test(calendarEventId)) {
    return jsonResponse(400, {
      ok: false,
      error: "calendarEventId must be a valid UUID",
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let stage = "load_calendar_event";
  try {
    // 1. Load calendar_event
    const { data: evRaw, error: evErr } = await supabase
      .from("calendar_events")
      .select("id, user_id, workspace_id, lead_id, platform, meeting_url, raw_event")
      .eq("id", calendarEventId)
      .maybeSingle();
    if (evErr) {
      throw new Error(`calendar_events lookup failed: ${evErr.message}`);
    }
    if (!evRaw) {
      return jsonResponse(404, { ok: false, error: "Calendar event not found" });
    }
    const ev = evRaw as unknown as CalendarEventRow;

    if (ev.platform !== "google_meet") {
      return jsonResponse(400, {
        ok: false,
        error: `Calendar event platform is '${ev.platform ?? "null"}', expected 'google_meet'`,
      });
    }
    if (!ev.lead_id) {
      return jsonResponse(400, {
        ok: false,
        error: "calendar event not linked to a lead",
      });
    }

    // 2. Extract meeting code
    stage = "extract_meeting_code";
    const meetingCode = extractMeetingCode(ev);
    if (!meetingCode) {
      return jsonResponse(400, {
        ok: false,
        error: "Could not extract a meeting code from raw_event or meeting_url",
      });
    }

    // 3. Idempotency check
    stage = "idempotency_check";
    const { data: existingRaw, error: existErr } = await supabase
      .from("meeting_transcripts")
      .select("id, status, fetch_attempts")
      .eq("calendar_event_id", calendarEventId)
      .maybeSingle();
    if (existErr) {
      throw new Error(`meeting_transcripts lookup failed: ${existErr.message}`);
    }
    const existing = (existingRaw ?? null) as TranscriptRow | null;
    if (existing && existing.status === "ready") {
      return jsonResponse(200, {
        ok: true,
        status: "ready",
        reason: null,
        transcriptId: existing.id,
        skipped: "already_ready",
      });
    }

    // 4. Token retrieval + refresh
    stage = "token_retrieval";
    const { data: connRaw, error: connErr } = await supabase
      .from("gmail_connections")
      .select("user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at")
      .eq("user_id", ev.user_id)
      .maybeSingle();
    if (connErr) {
      throw new Error(`gmail_connections lookup failed: ${connErr.message}`);
    }
    if (!connRaw) {
      return jsonResponse(400, {
        ok: false,
        error: "user has no connected Google account",
      });
    }
    const connection = connRaw as unknown as GmailConnectionRow;

    let accessToken: string;
    try {
      accessToken = await refreshTokenIfNeeded(supabase, connection);
    } catch (refreshErr) {
      if (refreshErr instanceof InvalidGrantError) {
        const transcriptId = await upsertTranscriptRow(
          supabase,
          ev,
          existing,
          "failed",
          "TOKEN_INVALID",
          null,
        );
        return jsonResponse(200, {
          ok: true,
          status: "failed",
          reason: "TOKEN_INVALID",
          transcriptId,
        });
      }
      throw refreshErr;
    }

    // 5. Upsert to 'fetching'
    stage = "upsert_fetching";
    const transcriptId = await upsertTranscriptRow(
      supabase,
      ev,
      existing,
      "fetching",
      null,
      null,
    );

    // 6. Call helper
    stage = "fetch_transcript";
    const client = new GoogleMeetClient(accessToken);
    const result = await client.fetchTranscriptForMeetingCode(meetingCode);

    // 7. Map result to UPDATE
    stage = "persist_result";
    const reason = resultReason(result);
    const providerErrorDetail =
      result.status === "failed" ? (result.detail ?? null) : null;
    // deno-lint-ignore no-explicit-any
    const updates: Record<string, any> = {
      status: result.status,
      status_reason: reason,
      provider_error_detail: providerErrorDetail,
    };
    if (result.status === "ready") {
      updates.transcript_text = JSON.stringify(result.entries);
      updates.transcript_format = "json";
      updates.provider_meeting_id = result.providerMeetingId;
      updates.ready_at = new Date().toISOString();
    }
    const { error: updateErr } = await supabase
      .from("meeting_transcripts")
      .update(updates)
      .eq("id", transcriptId);
    if (updateErr) {
      throw new Error(`meeting_transcripts result update failed: ${updateErr.message}`);
    }

    // 8. Project a timeline item iff newly ready
    if (result.status === "ready") {
      stage = "project_timeline";
      await projectTimelineItem(supabase, {
        workspace_id: ev.workspace_id,
        lead_id: ev.lead_id,
        channel: "meeting",
        provider: "google_meet",
        event_type: "meeting_transcript_captured",
        occurred_at: new Date().toISOString(),
        source_table: "meeting_transcripts",
        source_id: transcriptId,
        subject: "Meeting transcript captured",
        snippet_text: "Transcript captured from Google Meet",
        metadata_json: {
          meeting_transcript_id: transcriptId,
          calendar_event_id: ev.id,
          provider_meeting_id: result.providerMeetingId,
        },
        dedupe_key: `meeting_transcript:${transcriptId}`,
      });
    }

    // 9. Return
    return jsonResponse(200, {
      ok: true,
      status: result.status,
      reason,
      transcriptId: transcriptId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[meet-transcript-fetch] unexpected_error", {
      calendarEventId,
      stage,
      error: message,
    });
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }
});
