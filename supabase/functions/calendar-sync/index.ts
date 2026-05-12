// ============================================================
// calendar-sync — Phase 1 of calendar awareness
//
// Pulls upcoming meetings from connected Google Calendar and
// Microsoft Outlook Calendar, matches them to leads by attendee
// email, and upserts into `calendar_events`.
//
// - Window: now → +14 days
// - Only writes events that match a lead in the same workspace.
//   Unmatched events are skipped (Phase 2 will revisit).
// - On invalid_grant during refresh: marks `needs_reconnect=true`
//   on the connection row and continues with the next user.
//
// Called by cron-dispatcher every 15 minutes.
// Auth: X-Internal-Secret header (from cron-dispatcher).
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encryptToken, safeDecryptToken } from "../_shared/encryption.ts";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";
import {
  OUTLOOK_CALENDAR_SCOPE,
  OUTLOOK_CALENDAR_SCOPES_STRING,
} from "../_shared/outlookScopes.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WINDOW_DAYS = 14;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

type CalendarPlatform = "google_meet" | "teams" | "zoom" | "other";

interface CalendarEventRow {
  workspace_id: string;
  user_id: string;
  lead_id: string;
  provider: "google" | "microsoft";
  external_event_id: string;
  platform: CalendarPlatform | null;
  title: string | null;
  start_time: string;
  end_time: string | null;
  attendees_emails: string[];
  meeting_url: string | null;
  organizer_email: string | null;
  status: "scheduled" | "in_progress" | "ended" | "cancelled";
  raw_event: unknown;
}

function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

// ─── Google Calendar ────────────────────────────────────────────

interface GoogleConnectionRow {
  user_id: string;
  gmail_email: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string;
  granted_scopes: string[] | null;
  needs_reconnect: boolean | null;
}

interface GoogleEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; organizer?: boolean }>;
  organizer?: { email?: string };
  hangoutLink?: string;
  conferenceData?: {
    conferenceSolution?: { key?: { type?: string } };
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
  status?: string;
  location?: string;
}

async function refreshGoogleToken(
  supabase: SupabaseClient,
  conn: GoogleConnectionRow,
): Promise<string | null> {
  const expiresAt = new Date(conn.token_expires_at).getTime();
  const decryptedAccess = await safeDecryptToken(conn.access_token_encrypted ?? "");
  if (expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return decryptedAccess;
  }

  const decryptedRefresh = await safeDecryptToken(conn.refresh_token_encrypted ?? "");
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret || !decryptedRefresh) {
    console.error("[calendar-sync] Google refresh prerequisites missing");
    return null;
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decryptedRefresh,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[calendar-sync] Google refresh failed for user=${conn.user_id}: ${resp.status} ${body}`);
    if (resp.status === 400 && body.includes("invalid_grant")) {
      await supabase
        .from("gmail_connections")
        .update({ needs_reconnect: true })
        .eq("user_id", conn.user_id);
    }
    return null;
  }

  const tokens = await resp.json();
  const newAccess: string = tokens.access_token;
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const hasKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
  const encAccess = hasKey ? await encryptToken(newAccess) : newAccess;

  await supabase
    .from("gmail_connections")
    .update({
      access_token_encrypted: encAccess,
      token_expires_at: newExpiresAt,
      needs_reconnect: false,
    })
    .eq("user_id", conn.user_id);

  return newAccess;
}

function detectGooglePlatform(ev: GoogleEvent): { platform: CalendarPlatform; meetingUrl: string | null } {
  const conferenceType = ev.conferenceData?.conferenceSolution?.key?.type;
  if (conferenceType === "hangoutsMeet" || ev.hangoutLink) {
    const uri = ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri
      ?? ev.hangoutLink
      ?? null;
    return { platform: "google_meet", meetingUrl: uri };
  }
  const location = (ev.location ?? "").toLowerCase();
  const description = JSON.stringify(ev.conferenceData ?? {}).toLowerCase();
  if (location.includes("zoom.us") || description.includes("zoom.us")) {
    const uri = ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri
      ?? (ev.location?.match(/https?:\/\/\S+/)?.[0] ?? null);
    return { platform: "zoom", meetingUrl: uri };
  }
  if (location.includes("teams.microsoft.com") || description.includes("teams.microsoft.com")) {
    const uri = ev.location?.match(/https?:\/\/\S+/)?.[0] ?? null;
    return { platform: "teams", meetingUrl: uri };
  }
  return { platform: "other", meetingUrl: null };
}

async function fetchGoogleEvents(accessToken: string): Promise<GoogleEvent[]> {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "100");

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Google Calendar list failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  return Array.isArray(data.items) ? data.items : [];
}

// ─── Outlook Calendar ──────────────────────────────────────────

interface OutlookAccountRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  email_address: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  granted_scopes: string[] | null;
  needs_reconnect: boolean | null;
}

interface OutlookEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  organizer?: { emailAddress?: { address?: string } };
  onlineMeetingProvider?: string;
  onlineMeeting?: { joinUrl?: string };
  isCancelled?: boolean;
  location?: { displayName?: string };
}

async function refreshOutlookToken(
  supabase: SupabaseClient,
  account: OutlookAccountRow,
): Promise<string | null> {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  const decryptedAccess = await safeDecryptToken(account.access_token ?? "");
  if (expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return decryptedAccess;
  }

  const decryptedRefresh = await safeDecryptToken(account.refresh_token ?? "");
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");
  if (!clientId || !clientSecret || !decryptedRefresh) {
    console.error("[calendar-sync] Microsoft refresh prerequisites missing");
    return null;
  }

  const resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decryptedRefresh,
      client_id: clientId,
      client_secret: clientSecret,
      scope: OUTLOOK_CALENDAR_SCOPES_STRING,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[calendar-sync] Outlook refresh failed for account=${account.id}: ${resp.status} ${body}`);
    if (body.includes("invalid_grant")) {
      await supabase
        .from("mail_accounts")
        .update({ needs_reconnect: true })
        .eq("id", account.id);
    }
    return null;
  }

  const tokens = await resp.json();
  const newAccess: string = tokens.access_token;
  const newRefresh: string = tokens.refresh_token ?? decryptedRefresh;
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const hasKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
  const [encAccess, encRefresh] = await Promise.all([
    hasKey ? encryptToken(newAccess) : Promise.resolve(newAccess),
    hasKey ? encryptToken(newRefresh) : Promise.resolve(newRefresh),
  ]);

  await supabase
    .from("mail_accounts")
    .update({
      access_token: encAccess,
      refresh_token: encRefresh,
      token_expires_at: newExpiresAt,
      needs_reconnect: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);

  return newAccess;
}

function outlookDateToIso(dt: { dateTime?: string; timeZone?: string } | undefined): string | null {
  // Microsoft Graph + Prefer: outlook.timezone="UTC" returns naive UTC strings
  // ("2024-01-15T10:00:00.0000000"). Treat as UTC by appending Z when the
  // string lacks a timezone designator.
  const s = dt?.dateTime;
  if (!s) return null;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).toISOString();
  return new Date(s + "Z").toISOString();
}

function detectOutlookPlatform(ev: OutlookEvent): { platform: CalendarPlatform; meetingUrl: string | null } {
  const provider = ev.onlineMeetingProvider;
  const joinUrl = ev.onlineMeeting?.joinUrl ?? null;
  if (provider === "teamsForBusiness") return { platform: "teams", meetingUrl: joinUrl };
  if (joinUrl?.includes("zoom.us")) return { platform: "zoom", meetingUrl: joinUrl };
  if (joinUrl?.includes("meet.google.com")) return { platform: "google_meet", meetingUrl: joinUrl };
  const location = (ev.location?.displayName ?? "").toLowerCase();
  if (location.includes("teams.microsoft.com")) return { platform: "teams", meetingUrl: joinUrl };
  if (location.includes("zoom.us")) return { platform: "zoom", meetingUrl: joinUrl };
  return { platform: "other", meetingUrl: joinUrl };
}

async function fetchOutlookEvents(accessToken: string): Promise<OutlookEvent[]> {
  const startDateTime = new Date().toISOString();
  const endDateTime = new Date(Date.now() + WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const url = new URL("https://graph.microsoft.com/v1.0/me/calendarview");
  url.searchParams.set("startDateTime", startDateTime);
  url.searchParams.set("endDateTime", endDateTime);
  url.searchParams.set("$top", "100");
  url.searchParams.set(
    "$select",
    "id,subject,start,end,attendees,organizer,onlineMeetingProvider,onlineMeeting,isCancelled,location",
  );

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Graph calendarview failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  return Array.isArray(data.value) ? data.value : [];
}

// ─── Lead matching + upsert ────────────────────────────────────

async function matchLeadsByEmail(
  supabase: SupabaseClient,
  workspaceId: string,
  emails: Set<string>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (emails.size === 0) return map;
  const { data, error } = await supabase
    .from("leads")
    .select("id, email")
    .eq("workspace_id", workspaceId)
    .in("email", Array.from(emails));
  if (error) {
    console.error("[calendar-sync] lead lookup failed:", error.message);
    return map;
  }
  for (const row of data ?? []) {
    const e = normalizeEmail(row.email);
    if (e && !map.has(e)) map.set(e, row.id);
  }
  return map;
}

async function resolveGmailWorkspaceId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (error || !data?.workspace_id) return null;
  return data.workspace_id;
}

async function upsertCalendarEvents(
  supabase: SupabaseClient,
  rows: CalendarEventRow[],
): Promise<{ written: number; failed: number }> {
  if (rows.length === 0) return { written: 0, failed: 0 };
  const { error } = await supabase
    .from("calendar_events")
    .upsert(rows, { onConflict: "user_id,provider,external_event_id" });
  if (error) {
    console.error(`[calendar-sync] upsert failed (${rows.length} rows):`, error.message);
    return { written: 0, failed: rows.length };
  }
  return { written: rows.length, failed: 0 };
}

// ─── Per-user processors ───────────────────────────────────────

async function processGoogleConnection(
  supabase: SupabaseClient,
  conn: GoogleConnectionRow,
): Promise<{ matched: number; total: number; skipped?: string }> {
  const scopes = conn.granted_scopes ?? [];
  if (!scopes.includes(GOOGLE_CALENDAR_SCOPE)) {
    return { matched: 0, total: 0, skipped: "missing_calendar_scope" };
  }
  if (conn.needs_reconnect) {
    return { matched: 0, total: 0, skipped: "needs_reconnect" };
  }

  const workspaceId = await resolveGmailWorkspaceId(supabase, conn.user_id);
  if (!workspaceId) return { matched: 0, total: 0, skipped: "no_workspace" };

  const accessToken = await refreshGoogleToken(supabase, conn);
  if (!accessToken) return { matched: 0, total: 0, skipped: "refresh_failed" };

  let events: GoogleEvent[];
  try {
    events = await fetchGoogleEvents(accessToken);
  } catch (err) {
    console.error(`[calendar-sync] Google fetch failed for user=${conn.user_id}:`, err);
    return { matched: 0, total: 0, skipped: "fetch_failed" };
  }

  const allAttendeeEmails = new Set<string>();
  for (const ev of events) {
    for (const a of ev.attendees ?? []) {
      const e = normalizeEmail(a.email);
      if (e && e !== normalizeEmail(conn.gmail_email)) allAttendeeEmails.add(e);
    }
  }
  const leadByEmail = await matchLeadsByEmail(supabase, workspaceId, allAttendeeEmails);

  const rows: CalendarEventRow[] = [];
  for (const ev of events) {
    if (!ev.id || !ev.start?.dateTime) continue;
    const attendeeEmails = (ev.attendees ?? [])
      .map((a) => normalizeEmail(a.email))
      .filter((e) => e.length > 0);
    let matchedLeadId: string | null = null;
    for (const e of attendeeEmails) {
      const leadId = leadByEmail.get(e);
      if (leadId) { matchedLeadId = leadId; break; }
    }
    if (!matchedLeadId) continue;

    const { platform, meetingUrl } = detectGooglePlatform(ev);
    const status: CalendarEventRow["status"] = ev.status === "cancelled" ? "cancelled" : "scheduled";

    rows.push({
      workspace_id: workspaceId,
      user_id: conn.user_id,
      lead_id: matchedLeadId,
      provider: "google",
      external_event_id: ev.id,
      platform,
      title: ev.summary ?? null,
      start_time: ev.start.dateTime,
      end_time: ev.end?.dateTime ?? null,
      attendees_emails: attendeeEmails,
      meeting_url: meetingUrl,
      organizer_email: normalizeEmail(ev.organizer?.email) || null,
      status,
      raw_event: ev,
    });
  }

  const { written, failed } = await upsertCalendarEvents(supabase, rows);
  return { matched: written, total: events.length, ...(failed ? { skipped: "upsert_partial" } : {}) };
}

async function processOutlookAccount(
  supabase: SupabaseClient,
  account: OutlookAccountRow,
): Promise<{ matched: number; total: number; skipped?: string }> {
  if (!account.user_id) {
    return { matched: 0, total: 0, skipped: "no_user_id" };
  }
  const scopes = account.granted_scopes ?? [];
  if (!scopes.includes(OUTLOOK_CALENDAR_SCOPE)) {
    return { matched: 0, total: 0, skipped: "missing_calendar_scope" };
  }
  if (account.needs_reconnect) {
    return { matched: 0, total: 0, skipped: "needs_reconnect" };
  }

  const accessToken = await refreshOutlookToken(supabase, account);
  if (!accessToken) return { matched: 0, total: 0, skipped: "refresh_failed" };

  let events: OutlookEvent[];
  try {
    events = await fetchOutlookEvents(accessToken);
  } catch (err) {
    console.error(`[calendar-sync] Outlook fetch failed for account=${account.id}:`, err);
    return { matched: 0, total: 0, skipped: "fetch_failed" };
  }

  const allAttendeeEmails = new Set<string>();
  for (const ev of events) {
    for (const a of ev.attendees ?? []) {
      const e = normalizeEmail(a.emailAddress?.address);
      if (e && e !== normalizeEmail(account.email_address)) allAttendeeEmails.add(e);
    }
  }
  const leadByEmail = await matchLeadsByEmail(supabase, account.workspace_id, allAttendeeEmails);

  const rows: CalendarEventRow[] = [];
  for (const ev of events) {
    if (!ev.id || !ev.start?.dateTime) continue;
    const attendeeEmails = (ev.attendees ?? [])
      .map((a) => normalizeEmail(a.emailAddress?.address))
      .filter((e) => e.length > 0);
    let matchedLeadId: string | null = null;
    for (const e of attendeeEmails) {
      const leadId = leadByEmail.get(e);
      if (leadId) { matchedLeadId = leadId; break; }
    }
    if (!matchedLeadId) continue;

    const { platform, meetingUrl } = detectOutlookPlatform(ev);
    const status: CalendarEventRow["status"] = ev.isCancelled ? "cancelled" : "scheduled";
    const startIso = outlookDateToIso(ev.start);
    if (!startIso) continue;

    rows.push({
      workspace_id: account.workspace_id,
      user_id: account.user_id,
      lead_id: matchedLeadId,
      provider: "microsoft",
      external_event_id: ev.id,
      platform,
      title: ev.subject ?? null,
      start_time: startIso,
      end_time: outlookDateToIso(ev.end),
      attendees_emails: attendeeEmails,
      meeting_url: meetingUrl,
      organizer_email: normalizeEmail(ev.organizer?.emailAddress?.address) || null,
      status,
      raw_event: ev,
    });
  }

  const { written, failed } = await upsertCalendarEvents(supabase, rows);
  return { matched: written, total: events.length, ...(failed ? { skipped: "upsert_partial" } : {}) };
}

// ─── Entry point ───────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const startedAt = Date.now();
  let googleProcessed = 0;
  let googleMatched = 0;
  let outlookProcessed = 0;
  let outlookMatched = 0;

  // Google
  const { data: googleConns, error: googleErr } = await supabase
    .from("gmail_connections")
    .select("user_id, gmail_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, granted_scopes, needs_reconnect");
  if (googleErr) {
    console.error("[calendar-sync] Failed to load gmail_connections:", googleErr.message);
  } else {
    for (const conn of (googleConns ?? []) as GoogleConnectionRow[]) {
      try {
        const result = await processGoogleConnection(supabase, conn);
        googleProcessed += 1;
        googleMatched += result.matched;
        if (result.skipped) {
          console.log(`[calendar-sync] google user=${conn.user_id} skipped=${result.skipped}`);
        }
      } catch (err) {
        console.error(`[calendar-sync] google user=${conn.user_id} unhandled:`, err);
      }
    }
  }

  // Outlook
  const { data: outlookAccounts, error: outlookErr } = await supabase
    .from("mail_accounts")
    .select("id, workspace_id, user_id, email_address, access_token, refresh_token, token_expires_at, granted_scopes, needs_reconnect")
    .eq("provider", "outlook")
    .eq("status", "connected");
  if (outlookErr) {
    console.error("[calendar-sync] Failed to load mail_accounts:", outlookErr.message);
  } else {
    for (const account of (outlookAccounts ?? []) as OutlookAccountRow[]) {
      try {
        const result = await processOutlookAccount(supabase, account);
        outlookProcessed += 1;
        outlookMatched += result.matched;
        if (result.skipped) {
          console.log(`[calendar-sync] outlook account=${account.id} skipped=${result.skipped}`);
        }
      } catch (err) {
        console.error(`[calendar-sync] outlook account=${account.id} unhandled:`, err);
      }
    }
  }

  const summary = {
    duration_ms: Date.now() - startedAt,
    google: { processed: googleProcessed, matched_events: googleMatched },
    outlook: { processed: outlookProcessed, matched_events: outlookMatched },
    auth_source: auth.source,
  };
  console.log("[calendar-sync] done", JSON.stringify(summary));

  return new Response(JSON.stringify({ ok: true, ...summary }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
