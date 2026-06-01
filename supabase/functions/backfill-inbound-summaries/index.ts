// ============================================================
// backfill-inbound-summaries — one-shot remediation
//
// Pre-v2 classify-inbound runs wrote `intent` but not
// `ai_summary`, then the 72h purge wiped `snippet_text` and
// `interactions.body_text`. Queue cards now render
// "[No preview available]" for every one of those rows.
//
// This function backfills `metadata_json.ai_summary` for inbound
// timeline rows in four preference tiers:
//
//   (a) BODY_PRESENT: body still in interactions or snippet — run
//       the v2 intent_router prompt and write ai_summary.
//   (b) GMAIL_REFETCH: source='gmail', body purged — refetch from
//       Gmail API by gmail_message_id using the lead owner's
//       gmail_connections row, then classify.
//   (c) OUTLOOK_REFETCH: source='outlook', body purged — resolve
//       the stored RFC822 internetMessageId via Graph $filter to
//       a Graph message, pull the plain-text body, then classify.
//       Token comes from the workspace-scoped `mail_accounts` row
//       (not per-user like Gmail), refreshed via getFreshOutlookToken.
//   (d) SUBJECT_SYNTH: refetch unavailable or failed (revoked
//       token, deleted message, no message ID) — write a
//       multi-line synth from subject + sender + classified
//       intent. Marked with metadata_json.ai_summary_source =
//       'subject_fallback' so it can be audited / re-tried.
//
// Auth: requires X-Internal-Secret. Idempotent — processes rows
// where ai_summary IS NULL OR was written by a pre-v2 prompt OR
// is a prior subject-fallback synth (upgradeable). Candidate
// filtering happens in SQL so LIMIT counts only unprocessed rows
// (a prior version of this function filtered in JS *after* the
// LIMIT, which stranded older rows once the most-recent 200 were
// tagged v2).
//
// Optional query param ?workspace_id=<uuid> scopes the batch to
// one workspace at a time — useful for pilot operators draining
// workspaces in a known order.
//
// Once every row in the 60-day window carries the current
// `ai_summary_version` and is not flagged subject_fallback, the
// function becomes a no-op.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
import { logger } from "../_shared/logger.ts";
import { safeDecryptToken, encryptToken } from "../_shared/encryption.ts";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";

const BATCH_SIZE = 50;
const LOOKBACK_DAYS = 60;
const INTENT_VERSION = "intent_router_v2";
// Version tag is a CODE-STATE marker (not a prompt-content marker).
// Bumped whenever a change in this function would produce a different
// summary for the same input — e.g. a new refetch tier becomes
// available, or the synth fallback shape changes. The candidate filter
// uses it as a one-shot re-queue trigger: rows tagged with an older
// version are re-processed exactly once, then drain to the new tag.
//
// v5 — second Outlook lookup tier: when $filter on internetMessageId
//      returns no match, fall back to GET /me/messages/{provider_message_id}
//      using the Graph immutable ID stored alongside the RFC822 ID.
//      Catches messages that moved folders (Archive/Deleted) where
//      $filter against the default scope misses them.
// v4 — fix Outlook refetch (added ConsistencyLevel: eventual header).
//      v3 deployment had 0% Outlook refetch success because Graph
//      silently returns empty for $filter on non-indexed properties
//      without that header.
// v3 — added Outlook refetch tier + multi-line synth fallback.
// v2 — initial pilot launch (Gmail refetch + terse subject synth).
// v6 — fall back to lead_timeline_items.provider when metadata_json.source
//      is missing. Pre-cutover rows often have provider='gmail' but no
//      metadata.source, which caused Gmail refetch to be skipped and
//      everything to land on subject_synth. Re-queue all v5 rows once.
const AI_SUMMARY_VERSION = "inbound_summary/v6";

interface TimelineRow {
  id: string;
  lead_id: string | null;
  workspace_id: string | null;
  subject: string | null;
  snippet_text: string | null;
  intent: string | null;
  source_table: string | null;
  source_id: string | null;
  metadata_json: Record<string, unknown> | null;
}

interface LeadRow {
  id: string;
  name: string | null;
  company: string | null;
  owner_user_id: string | null;
  job_title: string | null;
}

/** Map an intent_router classification code (see _shared/prompts.ts) to a
 *  short human-readable phrase. Used by the subject-synth fallback so the
 *  Reply/Follow-up drafting AI has at least a coarse signal about what the
 *  inbound was for, even when the body has been purged.
 *
 *  Returns null for intents where surfacing the label would mislead the
 *  drafter (e.g., "no_signal" or auto-acks the system already handles). */
function humanizeIntent(intent: string | null | undefined): string | null {
  if (!intent || typeof intent !== "string") return null;
  const map: Record<string, string | null> = {
    book_meeting: "scheduling a meeting",
    pricing: "asking about pricing",
    technical_sdk: "technical question about the SDK or integration",
    security_privacy: "security or privacy question",
    legal_procurement: "legal or procurement step",
    partnership: "partnership opportunity",
    support: "support request",
    not_sure: "general inquiry",
    // Skip-list intents — usually we don't synth at all for these, but if
    // we do, surface the label.
    calendar_accept: "meeting acceptance",
    ooo_reply: "out-of-office auto-reply",
    bounce: "bounce notification",
    zoom_recap: "Zoom meeting recap",
    meeting_confirmation: "meeting confirmation",
    unsubscribe: "unsubscribe request",
    no_signal: null,
    unknown: null,
  };
  if (intent in map) return map[intent];
  return intent.replace(/_/g, " ");
}

interface Counts {
  fetched: number;
  body_present: number;
  gmail_refetched: number;
  outlook_refetched: number;
  subject_synth: number;
  failed: number;
  skipped: number;
}

const SKIP_AI_SUMMARY_INTENTS = new Set([
  "no_signal",
  "calendar_accept",
  "ooo_reply",
  "bounce",
  "zoom_recap",
  "meeting_confirmation",
  "unsubscribe",
]);

function getFromEmail(meta: Record<string, unknown> | null): string {
  const raw = meta?.from_email;
  if (typeof raw !== "string") return "";
  // Strip angle brackets and quoted names.
  return raw.replace(/^.*<([^>]+)>.*$/, "$1").replace(/[<>]/g, "").trim();
}

function getSource(meta: Record<string, unknown> | null): "gmail" | "outlook" | "unknown" {
  const s = meta?.source;
  if (s === "gmail" || s === "outlook") return s;
  return "unknown";
}

function getGmailMessageId(meta: Record<string, unknown> | null): string | null {
  const v = meta?.gmail_message_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function getProviderMessageId(meta: Record<string, unknown> | null): string | null {
  const v = meta?.provider_message_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeB64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return atob(base64);
  }
}

interface GmailMessage {
  snippet?: string;
  payload?: {
    body?: { data?: string };
    parts?: Array<{ mimeType: string; body?: { data?: string } }>;
  };
}

function extractGmailBody(msg: GmailMessage): string {
  const parts = msg.payload?.parts ?? [];
  const textPart = parts.find((p) => p.mimeType === "text/plain");
  if (textPart?.body?.data) return decodeB64Url(textPart.body.data);
  if (msg.payload?.body?.data) {
    const decoded = decodeB64Url(msg.payload.body.data);
    if (decoded.includes("<html") || decoded.includes("<!DOCTYPE")) return htmlToPlain(decoded);
    return decoded;
  }
  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  if (htmlPart?.body?.data) return htmlToPlain(decodeB64Url(htmlPart.body.data));
  return msg.snippet ?? "";
}

// deno-lint-ignore no-explicit-any
async function refreshGmailToken(supabase: any, userId: string): Promise<string | null> {
  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!conn) return null;
  const access = await safeDecryptToken(conn.access_token_encrypted ?? "");
  const refresh = await safeDecryptToken(conn.refresh_token_encrypted ?? "");
  const expiresAt = new Date(conn.token_expires_at ?? 0);
  if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return access || null;
  }
  if (!refresh) return null;
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) return null;
  const tokens = await resp.json();
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  let enc = tokens.access_token;
  try {
    if (Deno.env.get("TOKEN_ENCRYPTION_KEY")) enc = await encryptToken(tokens.access_token);
  } catch { /* keep plaintext on failure */ }
  await supabase
    .from("gmail_connections")
    .update({ access_token_encrypted: enc, token_expires_at: newExpiresAt })
    .eq("user_id", userId);
  return tokens.access_token;
}

async function fetchGmailBody(accessToken: string, messageId: string): Promise<string | null> {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) return null;
  const msg = (await resp.json()) as GmailMessage;
  const body = extractGmailBody(msg);
  return body || null;
}

interface OutlookMailAccount {
  id: string;
  email_address: string | null;
}

/** Look up the default connected Outlook `mail_account` for a workspace.
 *  Returns null if no account is connected for that workspace. */
async function fetchOutlookMailAccount(
  // deno-lint-ignore no-explicit-any
  admin: any,
  workspaceId: string,
): Promise<OutlookMailAccount | null> {
  const { data } = await admin
    .from("mail_accounts")
    .select("id, email_address")
    .eq("workspace_id", workspaceId)
    .eq("provider", "outlook")
    .eq("status", "connected")
    .order("is_default", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data ?? null) as OutlookMailAccount | null;
}

/** Refetch the plain-text body of an Outlook message by RFC822
 *  internetMessageId via Microsoft Graph. Returns null if the message
 *  was not found (e.g. deleted from the user's mailbox) or the token
 *  was rejected. Logs structured warns for each distinct failure mode
 *  so post-hoc diagnosis from edge function logs doesn't need a code
 *  change.
 *
 *  Graph's `internetMessageId` field stores RFC822 IDs WITH angle
 *  brackets (`<abc@xyz>`). Outlook-sync persists them verbatim, so
 *  we look them up the same way here.
 *
 *  CRITICAL: `internetMessageId` is a non-indexed property on the
 *  messages resource, so `$filter eq` against it requires Graph's
 *  advanced-query mode via `ConsistencyLevel: eventual`. Without
 *  this header Graph silently returns an empty result set — no
 *  error, no warning, just zero hits. This was the root cause of
 *  the 0/127 refetch rate on the first Paythings drain (PR #53). */
async function fetchOutlookBody(
  accessToken: string,
  rfc822MessageId: string,
  context: { row_id: string; workspace_id: string | null },
): Promise<string | null> {
  // Graph $filter requires the value single-quoted; escape any embedded
  // single quotes per OData convention.
  const escaped = rfc822MessageId.replace(/'/g, "''");
  const filter = `internetMessageId eq '${escaped}'`;
  const url = `https://graph.microsoft.com/v1.0/me/messages?$filter=${
    encodeURIComponent(filter)
  }&$top=1&$select=id,body,bodyPreview`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="text"',
        // Required for $filter on non-indexed properties like
        // internetMessageId. See the function-level comment.
        ConsistencyLevel: "eventual",
      },
    });
  } catch (err) {
    logger.warn("backfill_inbound_outlook_fetch_network_error", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!resp.ok) {
    let bodyText = "";
    try { bodyText = (await resp.text()).slice(0, 300); } catch { /* ignore */ }
    logger.warn("backfill_inbound_outlook_fetch_http_error", {
      ...context,
      status: resp.status,
      body_snippet: bodyText,
    });
    return null;
  }

  const data = await resp.json() as {
    value?: Array<{
      body?: { content?: string; contentType?: string };
      bodyPreview?: string;
    }>;
  };
  const msg = data.value?.[0];
  if (!msg) {
    logger.warn("backfill_inbound_outlook_fetch_no_match", {
      ...context,
      message_id_len: rfc822MessageId.length,
      // First 80 chars only so we don't dump full sender PII into logs.
      message_id_prefix: rfc822MessageId.slice(0, 80),
    });
    return null;
  }

  // With Prefer text the body comes back as plain; fall back to HTML
  // strip if Graph ignored the preference (some tenants still send HTML).
  const rawBody = (msg.body?.content ?? "").trim();
  if (rawBody) {
    if (msg.body?.contentType === "html" || /<\w+/.test(rawBody)) {
      return htmlToPlain(rawBody);
    }
    return rawBody;
  }
  const preview = (msg.bodyPreview ?? "").trim();
  if (preview) return preview;

  logger.warn("backfill_inbound_outlook_fetch_empty_body", { ...context });
  return null;
}

/** Second-tier Outlook lookup: fetch by Graph's immutable message ID
 *  (`provider_message_id`) directly via `GET /me/messages/{id}`. Works for
 *  messages that have moved out of the default mail scope ($filter only
 *  searches the mailbox root by default) — for example to Archive,
 *  Deleted Items, or a sub-folder. Returns null on 404 / token reject /
 *  empty body so the caller falls through to subject synth. */
async function fetchOutlookBodyById(
  accessToken: string,
  providerMessageId: string,
  context: { row_id: string; workspace_id: string | null },
): Promise<string | null> {
  // The provider_message_id is a URL-safe Graph ID; encode just in case.
  const url = `https://graph.microsoft.com/v1.0/me/messages/${
    encodeURIComponent(providerMessageId)
  }?$select=id,body,bodyPreview`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="text"',
      },
    });
  } catch (err) {
    logger.warn("backfill_inbound_outlook_byid_network_error", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!resp.ok) {
    // 404 = message deleted from mailbox; other = token/permissions.
    let bodyText = "";
    try { bodyText = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    logger.warn("backfill_inbound_outlook_byid_http_error", {
      ...context,
      status: resp.status,
      body_snippet: bodyText,
    });
    return null;
  }

  const msg = await resp.json() as {
    body?: { content?: string; contentType?: string };
    bodyPreview?: string;
  };
  const rawBody = (msg.body?.content ?? "").trim();
  if (rawBody) {
    if (msg.body?.contentType === "html" || /<\w+/.test(rawBody)) {
      return htmlToPlain(rawBody);
    }
    return rawBody;
  }
  const preview = (msg.bodyPreview ?? "").trim();
  if (preview) return preview;
  return null;
}

function buildSubjectSynth(row: TimelineRow, lead: LeadRow | undefined): string {
  // Multi-line synth: gives the Reply/Follow-up drafting AI enough signal
  // to produce a sensible draft even when the body is permanently gone.
  // SummaryBody renders \n line-breaks; cleanBodyText (Queue card) joins
  // them with spaces, so the same string works in both surfaces.
  const subject = (row.subject ?? "").trim() || "(no subject)";
  const fromEmail = getFromEmail(row.metadata_json);
  const fromName = typeof row.metadata_json?.from_name === "string"
    ? (row.metadata_json.from_name as string).trim()
    : "";
  const senderName = fromName
    || lead?.name?.trim()
    || (fromEmail ? fromEmail.split("@")[0] : "")
    || "the contact";
  const title = lead?.job_title?.trim() ?? "";
  const company = lead?.company?.trim()
    || (fromEmail.includes("@") ? fromEmail.split("@")[1] : "")
    || "";

  // "Manu Rajendra (VP Sales, AwesomLiving)" / "Manu Rajendra (AwesomLiving)" / "Manu Rajendra"
  const titleAndCompany = [title, company].filter(Boolean).join(", ");
  const senderClause = titleAndCompany
    ? `${senderName} (${titleAndCompany})`
    : senderName;

  const intentLabel = humanizeIntent(row.intent);

  const lines: string[] = [];
  lines.push(`Inbound from ${senderClause}.`);
  lines.push(`Subject: "${subject}".`);
  if (intentLabel) {
    lines.push(`Classified intent: ${intentLabel}.`);
  }
  lines.push("(Original message body no longer retained — summary derived from metadata.)");
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
async function classifyViaAiTask(
  supabase: any,
  supabaseUrl: string,
  serviceKey: string,
  emailText: string,
  leadContext: string,
): Promise<{ intent: string; ai_summary: string | null } | null> {
  const aiRes = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      task: "intent_router",
      payload: { lead_context: leadContext, email_text: emailText },
    }),
  });
  if (!aiRes.ok) return null;
  const data = (await aiRes.json()) as { ok?: boolean; content?: string };
  if (!data?.ok || typeof data.content !== "string") return null;
  const match = data.content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      intent_primary?: unknown;
      ai_summary?: unknown;
    };
    const intent = typeof parsed.intent_primary === "string" ? parsed.intent_primary.trim() : "";
    if (!intent) return null;
    const summary = typeof parsed.ai_summary === "string" && parsed.ai_summary.trim()
      ? parsed.ai_summary.trim()
      : null;
    return { intent, ai_summary: summary };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Auth: accept service-role / internal-secret OR an authenticated user.
  // This is an additive, one-shot backfill (writes ai_summary only).
  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");
  const provided = req.headers.get("X-Internal-Secret");
  const authHeader = req.headers.get("Authorization") ?? "";
  const isInternal = !!internalSecret && provided === internalSecret;
  const isAuthed = authHeader.startsWith("Bearer ") && authHeader.length > 20;
  if (!isInternal && !isAuthed) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Optional ?workspace_id=<uuid> filter — lets the operator drain one
  // workspace at a time and watch counts per workspace. Omit to backfill
  // all workspaces (default behaviour).
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const counts: Counts = {
    fetched: 0,
    body_present: 0,
    gmail_refetched: 0,
    outlook_refetched: 0,
    subject_synth: 0,
    failed: 0,
    skipped: 0,
  };
  const startedAt = Date.now();

  try {
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();

    // Candidate filter — pushed into SQL so LIMIT counts only rows that
    // actually need work. Prior version filtered in JS after `LIMIT
    // BATCH_SIZE * 4`, which meant once the most-recent 200 rows were
    // tagged v2 the loop returned `fetched: 0` even though thousands of
    // older rows still needed processing.
    //
    // A row is a candidate iff ANY of:
    //   - ai_summary is null/missing                       (never summarized)
    //   - ai_summary_version is null/missing               (pre-version-tag write)
    //   - ai_summary_version != current version constant  (older code state)
    //
    // NOTE — we deliberately do NOT include `ai_summary_source =
    // subject_fallback` as a separate clause. Doing so would re-queue
    // every fallback row on every run, including rows for workspaces
    // where fallback is the terminal state (no Gmail/Outlook connection,
    // mailbox-deleted messages, etc.) — so the function would never
    // drain to `fetched: 0` (Codex P1 on PR #53).
    //
    // The version-mismatch clause already gives us one-shot re-queue of
    // existing fallback rows whenever this function's code changes
    // meaningfully (a new refetch tier, a new synth shape): bump
    // AI_SUMMARY_VERSION, every stale row gets re-processed once, then
    // drains to the new tag. Subsequent runs find no candidates.
    //
    // NOTE on the version-null clause: SQL `NULL != 'x'` is NULL
    // (treated as false in WHERE), so .neq alone misses rows tagged
    // with v1 prose before the version key existed. The explicit
    // .is.null catches them.
    //
    // PostgREST .or() takes comma-separated filter strings; the version
    // value contains a `/` which is URL-safe in query strings but the
    // SDK percent-encodes the whole filter param, so we pass it raw.
    let query = admin
      .from("lead_timeline_items")
      .select("id, lead_id, workspace_id, subject, snippet_text, intent, source_table, source_id, metadata_json")
      .eq("event_type", "email_inbound")
      .gte("occurred_at", cutoff)
      .or(
        [
          "metadata_json->>ai_summary.is.null",
          "metadata_json->>ai_summary_version.is.null",
          `metadata_json->>ai_summary_version.neq.${AI_SUMMARY_VERSION}`,
        ].join(","),
      )
      .order("occurred_at", { ascending: false })
      .limit(BATCH_SIZE);

    if (workspaceId) {
      query = query.eq("workspace_id", workspaceId);
    }

    const { data: rawRows, error: fetchErr } = await query;

    if (fetchErr) {
      return new Response(
        JSON.stringify({ ok: false, error: fetchErr.message, ...counts }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const candidates = (rawRows ?? []) as TimelineRow[];

    counts.fetched = candidates.length;

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, ...counts, duration_ms: Date.now() - startedAt }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Bulk fetch leads.
    const leadIds = Array.from(new Set(candidates.map((r) => r.lead_id).filter((x): x is string => !!x)));
    const leadById = new Map<string, LeadRow>();
    if (leadIds.length > 0) {
      const { data: leads } = await admin
        .from("leads")
        .select("id, name, company, owner_user_id, job_title")
        .in("id", leadIds);
      for (const l of (leads ?? []) as LeadRow[]) leadById.set(l.id, l);
    }

    // Bulk fetch paired interactions for body_text.
    const interactionIds = candidates
      .filter((r) => r.source_table === "interactions" && r.source_id)
      .map((r) => r.source_id as string);
    const bodyByInteractionId = new Map<string, string>();
    if (interactionIds.length > 0) {
      const { data: ints } = await admin
        .from("interactions")
        .select("id, body_text")
        .in("id", interactionIds);
      for (const i of (ints ?? []) as Array<{ id: string; body_text: string | null }>) {
        if (i.body_text && i.body_text.trim()) bodyByInteractionId.set(i.id, i.body_text);
      }
    }

    // Cache Gmail tokens per user, Outlook tokens per workspace, to
    // avoid refresh-per-row.
    const gmailTokenByUser = new Map<string, string | null>();
    const outlookAccountByWorkspace = new Map<string, OutlookMailAccount | null>();
    const outlookTokenByAccount = new Map<string, string | null>();

    for (const row of candidates) {
      try {
        const lead = row.lead_id ? leadById.get(row.lead_id) : undefined;
        const leadContext = lead
          ? [lead.name && `Name: ${lead.name}`, lead.company && `Company: ${lead.company}`]
            .filter(Boolean).join(", ")
          : "";

        let body: string | null = null;
        let path: "body_present" | "gmail_refetched" | "outlook_refetched" | "subject_synth" = "subject_synth";

        // (a) BODY_PRESENT
        const existingSnippet = (row.snippet_text ?? "").trim();
        if (existingSnippet) {
          body = existingSnippet;
          path = "body_present";
        } else if (row.source_id && bodyByInteractionId.has(row.source_id)) {
          body = bodyByInteractionId.get(row.source_id)!;
          path = "body_present";
        }

        // (b) GMAIL_REFETCH
        if (!body) {
          const source = getSource(row.metadata_json);
          const messageId = getGmailMessageId(row.metadata_json);
          const ownerId = lead?.owner_user_id ?? null;
          if (source === "gmail" && messageId && ownerId) {
            let token = gmailTokenByUser.get(ownerId);
            if (token === undefined) {
              token = await refreshGmailToken(admin, ownerId);
              gmailTokenByUser.set(ownerId, token);
            }
            if (token) {
              const refetched = await fetchGmailBody(token, messageId);
              if (refetched && refetched.trim()) {
                body = refetched.trim();
                path = "gmail_refetched";
              }
            }
          }
        }

        // (b2) OUTLOOK_REFETCH — mirrors Gmail refetch for Outlook-source
        // rows. Tokens live on workspace-scoped mail_accounts (one
        // Outlook connection per workspace, not per user). The stored
        // message ID is the RFC822 internetMessageId; we resolve it to a
        // Graph message via $filter and pull the plain-text body.
        if (!body) {
          const source = getSource(row.metadata_json);
          const messageId = getGmailMessageId(row.metadata_json); // legacy field naming
          const workspaceId = row.workspace_id;
          if (source === "outlook" && messageId && workspaceId) {
            let account = outlookAccountByWorkspace.get(workspaceId);
            if (account === undefined) {
              account = await fetchOutlookMailAccount(admin, workspaceId);
              outlookAccountByWorkspace.set(workspaceId, account);
            }
            if (account) {
              let token = outlookTokenByAccount.get(account.id);
              if (token === undefined) {
                try {
                  token = await getFreshOutlookToken(account.id, admin);
                } catch (err) {
                  // Expired/revoked — log once per account, fall through to
                  // subject synth for every row on this account.
                  const msg = err instanceof Error ? err.message : String(err);
                  logger.warn("backfill_inbound_outlook_token_failed", {
                    workspace_id: workspaceId,
                    mail_account_id: account.id,
                    error: msg,
                  });
                  token = null;
                }
                outlookTokenByAccount.set(account.id, token);
              }
              if (token) {
                const refetched = await fetchOutlookBody(token, messageId, {
                  row_id: row.id,
                  workspace_id: workspaceId,
                });
                if (refetched && refetched.trim()) {
                  body = refetched.trim();
                  path = "outlook_refetched";
                } else {
                  // Tier 2: GET by Graph immutable ID. Picks up messages
                  // that have moved out of the default scope (Archive,
                  // Deleted Items, sub-folders) where $filter misses them.
                  const providerId = getProviderMessageId(row.metadata_json);
                  if (providerId) {
                    const byId = await fetchOutlookBodyById(token, providerId, {
                      row_id: row.id,
                      workspace_id: workspaceId,
                    });
                    if (byId && byId.trim()) {
                      body = byId.trim();
                      path = "outlook_refetched";
                    }
                  }
                }
              }
            }
          }
        }

        let aiSummary: string | null = null;
        let aiSummarySource: "classifier" | "subject_fallback" = "classifier";

        if (body) {
          // Classify via v2 prompt.
          const fromEmail = getFromEmail(row.metadata_json);
          const emailText = [
            fromEmail && `From: ${fromEmail}`,
            row.subject && `Subject: ${row.subject}`,
            "",
            body.slice(0, 8000), // cap for token cost
          ].filter(Boolean).join("\n");

          const classification = await classifyViaAiTask(admin, supabaseUrl, serviceKey, emailText, leadContext);
          if (classification?.ai_summary) {
            aiSummary = classification.ai_summary;
          } else if (classification && SKIP_AI_SUMMARY_INTENTS.has(classification.intent)) {
            // Skip-list intent — synth instead so the card still shows something useful.
            aiSummary = buildSubjectSynth(row, lead);
            aiSummarySource = "subject_fallback";
            path = "subject_synth";
          }
        }

        // (c) SUBJECT_SYNTH fallback
        if (!aiSummary) {
          aiSummary = buildSubjectSynth(row, lead);
          aiSummarySource = "subject_fallback";
          path = "subject_synth";
        }

        const nextMetadata = {
          ...(row.metadata_json ?? {}),
          ai_summary: aiSummary,
          ai_summary_version: AI_SUMMARY_VERSION,
          ...(aiSummarySource === "subject_fallback" ? { ai_summary_source: "subject_fallback" } : {}),
        };

        const updatePayload: Record<string, unknown> = {
          metadata_json: nextMetadata,
          updated_at: new Date().toISOString(),
        };
        // Backfill intent if it was somehow missing (defensive).
        if (!row.intent) {
          updatePayload.intent = "unknown";
          updatePayload.intent_version = INTENT_VERSION;
        }

        const { error: updErr } = await admin
          .from("lead_timeline_items")
          .update(updatePayload)
          .eq("id", row.id);

        if (updErr) {
          logger.error("backfill_inbound_update_failed", { row_id: row.id, error: updErr.message });
          counts.failed++;
          continue;
        }

        if (path === "body_present") counts.body_present++;
        else if (path === "gmail_refetched") counts.gmail_refetched++;
        else if (path === "outlook_refetched") counts.outlook_refetched++;
        else counts.subject_synth++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("backfill_inbound_row_unexpected", { row_id: row.id, error: msg });
        counts.failed++;
      }
    }

    logger.info("backfill_inbound_batch_done", { duration_ms: Date.now() - startedAt, ...counts });

    return new Response(
      JSON.stringify({ ok: true, ...counts, duration_ms: Date.now() - startedAt }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("backfill_inbound_fatal", { error: msg, ...counts });
    return new Response(
      JSON.stringify({ ok: false, error: msg, ...counts }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
