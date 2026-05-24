// ============================================================
// backfill-inbound-summaries — one-shot remediation
//
// Pre-v2 classify-inbound runs wrote `intent` but not
// `ai_summary`, then the 72h purge wiped `snippet_text` and
// `interactions.body_text`. Queue cards now render
// "[No preview available]" for every one of those rows.
//
// This function backfills `metadata_json.ai_summary` for inbound
// timeline rows in three preference tiers:
//
//   (a) BODY_PRESENT: body still in interactions or snippet — run
//       the v2 intent_router prompt and write ai_summary.
//   (b) GMAIL_REFETCH: source='gmail', body purged — refetch from
//       Gmail API by gmail_message_id using the lead owner's
//       gmail_connections row, then classify.
//   (c) SUBJECT_SYNTH: refetch unavailable or failed (Outlook,
//       revoked token, deleted message) — write a deterministic
//       degraded summary built from subject + sender name +
//       company. Marked with metadata_json.ai_summary_source =
//       'subject_fallback' so it can be audited / re-tried.
//
// Outlook refetch is intentionally out of scope for this run —
// stored ID is the RFC822 Message-Id, which requires a Graph
// $filter resolve hop, not a single GET. Synth covers the
// preview need in the interim.
//
// Auth: requires X-Internal-Secret. Idempotent — only processes
// rows where metadata_json->>'ai_summary' IS NULL.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";
import { safeDecryptToken, encryptToken } from "../_shared/encryption.ts";

const BATCH_SIZE = 50;
const LOOKBACK_DAYS = 30;
const INTENT_VERSION = "intent_router_v2";

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
}

interface Counts {
  fetched: number;
  body_present: number;
  gmail_refetched: number;
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

function buildSubjectSynth(row: TimelineRow, lead: LeadRow | undefined): string {
  const subject = (row.subject ?? "").trim() || "(no subject)";
  const fromEmail = getFromEmail(row.metadata_json);
  const senderHint = lead?.name?.trim() ||
    (fromEmail ? fromEmail.split("@")[0] : "") ||
    "the contact";
  const companyHint = lead?.company?.trim() ||
    (fromEmail.includes("@") ? fromEmail.split("@")[1] : "");
  const companyPart = companyHint ? ` (${companyHint})` : "";
  return `Reply from ${senderHint}${companyPart} — subject: ${subject}`;
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

  // Internal-only.
  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");
  const provided = req.headers.get("X-Internal-Secret");
  if (!internalSecret || provided !== internalSecret) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const counts: Counts = {
    fetched: 0,
    body_present: 0,
    gmail_refetched: 0,
    subject_synth: 0,
    failed: 0,
    skipped: 0,
  };
  const startedAt = Date.now();

  try {
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();

    // Fetch candidates: inbound rows missing ai_summary.
    const { data: rawRows, error: fetchErr } = await admin
      .from("lead_timeline_items")
      .select("id, lead_id, workspace_id, subject, snippet_text, intent, source_table, source_id, metadata_json")
      .eq("event_type", "email_inbound")
      .gte("occurred_at", cutoff)
      .order("occurred_at", { ascending: false })
      .limit(BATCH_SIZE * 4); // overfetch; then filter ai_summary IS NULL in app

    if (fetchErr) {
      return new Response(
        JSON.stringify({ ok: false, error: fetchErr.message, ...counts }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const candidates = ((rawRows ?? []) as TimelineRow[]).filter(
      (r) => !(r.metadata_json && typeof (r.metadata_json as Record<string, unknown>).ai_summary === "string"
        && (r.metadata_json as Record<string, unknown>).ai_summary),
    ).slice(0, BATCH_SIZE);

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
        .select("id, name, company, owner_user_id")
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

    // Cache Gmail tokens per user to avoid refresh-per-row.
    const gmailTokenByUser = new Map<string, string | null>();

    for (const row of candidates) {
      try {
        const lead = row.lead_id ? leadById.get(row.lead_id) : undefined;
        const leadContext = lead
          ? [lead.name && `Name: ${lead.name}`, lead.company && `Company: ${lead.company}`]
            .filter(Boolean).join(", ")
          : "";

        let body: string | null = null;
        let path: "body_present" | "gmail_refetched" | "subject_synth" = "subject_synth";

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
