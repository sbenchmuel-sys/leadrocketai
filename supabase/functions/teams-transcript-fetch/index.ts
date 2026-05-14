// ============================================================
// teams-transcript-fetch
//
// Per-meeting Microsoft Teams transcript fetcher. Called by other
// internal edge functions (the Phase-2 poller) — never by a user,
// never by cron-dispatcher. Single-meeting scope: one
// calendar_event_id per invocation.
//
// Auth: privileged callers only (X-Internal-Secret or service-role
// bearer). Anonymous and user JWTs are rejected.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { requirePrivilegedCaller } from "../_shared/authz.ts";
import { projectTimelineItem } from "../_shared/timelineProjector.ts";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import {
  OUTLOOK_FULL_OAUTH_SCOPES_STRING,
  OUTLOOK_TRANSCRIPT_SCOPE,
} from "../_shared/outlookScopes.ts";
import {
  TeamsGraphClient,
  type TeamsTranscriptResult,
} from "../_shared/teamsTranscript.ts";

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
  end_time: string | null;
  raw_event: Record<string, unknown> | null;
}

interface MailAccountRow {
  id: string;
  granted_scopes: string[] | null;
}

interface TranscriptRow {
  id: string;
  status: string;
  fetch_attempts: number | null;
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
): Promise<string> {
  const nowIso = new Date().toISOString();
  if (existing) {
    const nextAttempts = (existing.fetch_attempts ?? 0) + 1;
    const { data, error } = await supabase
      .from("meeting_transcripts")
      .update({
        status,
        status_reason: statusReason,
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
      provider: "microsoft_teams",
      status,
      status_reason: statusReason,
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

function resultReason(result: TeamsTranscriptResult): string | null {
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
      .select("id, user_id, workspace_id, lead_id, platform, meeting_url, end_time, raw_event")
      .eq("id", calendarEventId)
      .maybeSingle();
    if (evErr) {
      throw new Error(`calendar_events lookup failed: ${evErr.message}`);
    }
    if (!evRaw) {
      return jsonResponse(404, { ok: false, error: "Calendar event not found" });
    }
    const ev = evRaw as unknown as CalendarEventRow;

    // calendar_events.platform uses the short identifier 'teams'.
    // meeting_transcripts.provider uses 'microsoft_teams' (CHECK-constrained
    // value). The mismatch is deliberate and pre-existing in the schema.
    if (ev.platform !== "teams") {
      return jsonResponse(400, {
        ok: false,
        error: `Calendar event platform is '${ev.platform ?? "null"}', expected 'teams'`,
      });
    }
    if (!ev.lead_id) {
      return jsonResponse(400, {
        ok: false,
        error: "calendar event not linked to a lead",
      });
    }
    if (!ev.meeting_url) {
      return jsonResponse(400, {
        ok: false,
        error: "calendar event has no meeting_url (Teams joinWebUrl)",
      });
    }
    if (!ev.end_time) {
      return jsonResponse(400, {
        ok: false,
        error: "calendar event has no end_time",
      });
    }

    // 2. Idempotency check
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

    // 3. Resolve mail_account_id for the calendar event's owner
    stage = "resolve_mail_account";
    const { data: accountRaw, error: accountErr } = await supabase
      .from("mail_accounts")
      .select("id, granted_scopes")
      .eq("user_id", ev.user_id)
      .eq("provider", "outlook")
      .eq("status", "connected")
      .maybeSingle();
    if (accountErr) {
      throw new Error(`mail_accounts lookup failed: ${accountErr.message}`);
    }
    if (!accountRaw) {
      return jsonResponse(400, {
        ok: false,
        error: "user has no connected Outlook account",
      });
    }
    const mailAccount = accountRaw as unknown as MailAccountRow;

    // Scope presence check: refusing here yields a clean unavailable
    // record. Without this, the refresh below would surface as a
    // generic "Outlook token refresh failed" once the user reconsents.
    const grantedScopes = mailAccount.granted_scopes ?? [];
    if (!grantedScopes.includes(OUTLOOK_TRANSCRIPT_SCOPE)) {
      const transcriptId = await upsertTranscriptRow(
        supabase,
        ev,
        existing,
        "failed",
        "SCOPE_NOT_GRANTED",
      );
      return jsonResponse(200, {
        ok: true,
        status: "failed",
        reason: "SCOPE_NOT_GRANTED",
        transcriptId,
      });
    }

    // 4. Token retrieval
    stage = "token_retrieval";
    let accessToken: string;
    try {
      accessToken = await getFreshOutlookToken(
        mailAccount.id,
        supabase,
        OUTLOOK_FULL_OAUTH_SCOPES_STRING,
      );
    } catch (tokenErr) {
      const message = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      console.warn("[teams-transcript-fetch] token_refresh_failed", {
        calendarEventId,
        mailAccountId: mailAccount.id,
        error: message,
      });
      const transcriptId = await upsertTranscriptRow(
        supabase,
        ev,
        existing,
        "failed",
        "TOKEN_INVALID",
      );
      return jsonResponse(200, {
        ok: true,
        status: "failed",
        reason: "TOKEN_INVALID",
        transcriptId,
      });
    }

    // 5. Upsert to 'fetching'
    stage = "upsert_fetching";
    const transcriptId = await upsertTranscriptRow(
      supabase,
      ev,
      existing,
      "fetching",
      null,
    );

    // 6. Call helper
    stage = "fetch_transcript";
    const client = new TeamsGraphClient(accessToken);
    const result = await client.fetchTranscriptForJoinUrl(
      ev.meeting_url,
      ev.end_time,
    );

    // 7. Map result to UPDATE
    stage = "persist_result";
    const reason = resultReason(result);
    // deno-lint-ignore no-explicit-any
    const updates: Record<string, any> = {
      status: result.status,
      status_reason: reason,
    };
    if (result.status === "ready") {
      updates.transcript_text = result.vtt;
      updates.transcript_format = "vtt";
      updates.provider_meeting_id = result.onlineMeetingId;
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
        provider: "microsoft_teams",
        event_type: "meeting_transcript_captured",
        occurred_at: new Date().toISOString(),
        source_table: "meeting_transcripts",
        source_id: transcriptId,
        subject: "Meeting transcript captured",
        snippet_text: "Transcript captured from Microsoft Teams",
        metadata_json: {
          meeting_transcript_id: transcriptId,
          calendar_event_id: ev.id,
          provider_meeting_id: result.onlineMeetingId,
        },
        dedupe_key: `meeting_transcript:${transcriptId}`,
      });
    }

    // 9. Return
    return jsonResponse(200, {
      ok: true,
      status: result.status,
      reason,
      transcriptId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[teams-transcript-fetch] unexpected_error", {
      calendarEventId,
      stage,
      error: message,
    });
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }
});
