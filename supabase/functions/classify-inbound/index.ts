// ============================================================
// classify-inbound — Phase 2a AI classifier cron
//
// Picks up `lead_timeline_items` rows where:
//   • event_type = 'email_inbound'
//   • intent IS NULL  (Phase 1 deterministic detectors didn't match)
// and classifies each via `ai_task.intent_router`, writing the
// returned `intent_primary` to `intent`, the returned `ai_summary` to
// `metadata_json.ai_summary` (atomically — see below), and the current
// `INTENT_VERSION` to `intent_version`.
//
// ai_summary is the durable, paraphrased counterpart to `snippet_text`
// that survives the 72h body purge (see CLAUDE.md "Public product
// commitments" + migration `_purge_gate_classified`). Reply-drafting
// context builders (`build-lead-context`, `ai_task` offer dedup) prefer
// `ai_summary` over `snippet_text` so reply quality doesn't degrade
// after purge.
//
// Atomic-or-nothing write: intent + ai_summary are written in a SINGLE
// UPDATE. If parsing of EITHER field fails (malformed JSON, missing
// field, out-of-vocab intent), we leave the row's `intent` NULL so the
// next tick retries. This avoids the "intent written, ai_summary
// missing, row marked classified so never retried" failure mode.
//
// Cron-driven (every 60 seconds via cron-dispatcher). NOT inlined
// into gmail-sync / outlook-sync / outlook-webhook — that decision
// is captured in EDGE_CASES.md §2 and AUDIT.md. Decoupling AI cost
// and latency from the load-bearing sync path is the whole point.
//
// Auth: requireScheduledCaller (X-Internal-Secret or service-role).
//
// Graceful degradation: rows past the 72-hour body-purge window have
// `snippet_text` NULL. The classifier still runs on subject + sender
// alone. Only rows with NO usable signal (no subject AND no sender
// AND no snippet) are written as `intent='unknown'` so they stop
// being re-polled.
//
// Per-row try/catch is hard: a single AI 5xx, parse error, or DB
// error must not throw out of the batch. Counts are logged at the
// end of every run.
//
// Re-entrancy: the cron schedule is every minute. If a run overruns
// 60s, a second run can start while the first is in flight. Each
// UPDATE is guarded by `.is("intent", null)` so the loser of any
// race silently no-ops instead of clobbering a concurrent write.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Small batch — keeps each run under the 60-second Edge Function
// budget even when ai_task takes a few seconds per call. 322 legacy
// rows ÷ 25 per minute ≈ 13 minutes to drain after deploy.
const BATCH_SIZE = 25;

// Classifier identifier written to `intent_version`. Bump the suffix
// when the prompt or model selection changes in a way that should
// trigger re-classification of older rows.
//
// v2 marker: prompt now also returns `ai_summary` (paraphrased
// 1–2 sentence durable summary). v1 rows do NOT have ai_summary in
// metadata_json — the read-side fallback in build-lead-context /
// ai_task handles the null gracefully. v1 rows are NOT auto-re-
// classified — they stay v1 (see KNOWN_ISSUES.md).
const INTENT_VERSION = "intent_router/v2";

// Allowed values returned by ai_task.intent_router (see
// supabase/functions/_shared/prompts.ts → PROMPTS.intent_router).
// We refuse anything outside this set and log it as a parse failure
// — better to leave the row NULL for a future run than to write an
// unknown enum-ish value that downstream queries can't reason about.
const ALLOWED_INTENTS: ReadonlySet<string> = new Set([
  "book_meeting",
  "pricing",
  "technical_sdk",
  "security_privacy",
  "legal_procurement",
  "partnership",
  "support",
  "not_sure",
]);

// Fallback intent for rows that have no usable content at all
// (no subject, no sender, no snippet — exceedingly rare). Writing a
// terminal value keeps the cron from spinning on the same row every
// minute. Mirrors the `unknown` value documented in
// 20260520120000_lead_timeline_items_intent.sql.
const NO_SIGNAL_INTENT = "unknown";

// Intents for which we DO NOT write `ai_summary` — no rep ever drafts
// a reply to these requiring body content (auto-replies, calendar
// acks, bounces, unsubscribes). Saves tokens AND avoids paraphrasing
// content that's already a structured artifact (calendar invite,
// OOO auto-text) into something less useful than the original.
//
// Intent is STILL written for these rows (queue filtering depends on
// it) — only ai_summary is skipped.
const SKIP_AI_SUMMARY_INTENTS: ReadonlySet<string> = new Set([
  NO_SIGNAL_INTENT,
  "calendar_accept",
  "ooo_reply",
  "bounce",
  "zoom_recap",
  "meeting_confirmation",
  "unsubscribe",
]);

interface TimelineRow {
  id: string;
  lead_id: string | null;
  subject: string | null;
  snippet_text: string | null;
  metadata_json: Record<string, unknown> | null;
}

interface LeadRow {
  id: string;
  name: string | null;
  company: string | null;
}

interface BatchCounts {
  fetched: number;
  classified: number;
  failed: number;
  skipped: number;
  /** Subset of classified — rows that got the NO_SIGNAL_INTENT fallback. */
  no_signal: number;
}

function buildLeadContext(lead: LeadRow | undefined): string {
  if (!lead) return "";
  const parts: string[] = [];
  if (lead.name) parts.push(`Name: ${lead.name}`);
  if (lead.company) parts.push(`Company: ${lead.company}`);
  return parts.join(", ");
}

function buildEmailText(row: TimelineRow): string {
  const fromEmail =
    typeof row.metadata_json?.from_email === "string"
      ? (row.metadata_json.from_email as string).trim()
      : "";
  const subject = (row.subject ?? "").trim();
  const snippet = (row.snippet_text ?? "").trim();

  const lines: string[] = [];
  if (fromEmail) lines.push(`From: ${fromEmail}`);
  if (subject) lines.push(`Subject: ${subject}`);
  if (snippet) {
    if (lines.length > 0) lines.push("");
    lines.push(snippet);
  }
  return lines.join("\n");
}

interface Classification {
  intent: string;
  /** May be null when the model omits the field (older clients) — caller
   *  treats that as "no summary this run" and skips the summary write. */
  ai_summary: string | null;
}

function extractClassification(content: string): Classification | null {
  // intent_router is prompted to return JSON ONLY, but the AI gateway
  // occasionally wraps responses in code fences or prose. Scan for
  // the first balanced-looking object literal and parse that.
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      intent_primary?: unknown;
      ai_summary?: unknown;
    };
    if (typeof parsed.intent_primary !== "string") return null;
    const intent = parsed.intent_primary.trim();
    if (!ALLOWED_INTENTS.has(intent)) return null;

    // ai_summary parsing: required by the v2 prompt but tolerated as
    // missing/empty so a model that omits the field doesn't block the
    // intent write. The skip-list above also drops summary writes for
    // intent classes where no rep ever needs the body content.
    let summary: string | null = null;
    if (typeof parsed.ai_summary === "string") {
      const trimmed = parsed.ai_summary.trim();
      if (trimmed.length > 0) summary = trimmed;
    }

    return { intent, ai_summary: summary };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const counts: BatchCounts = {
    fetched: 0,
    classified: 0,
    failed: 0,
    skipped: 0,
    no_signal: 0,
  };
  const startedAt = Date.now();

  try {
    // Priority sort: `expires_at ASC NULLS LAST, occurred_at ASC` —
    // near-expiry rows get classified first. Prevents a backlog from
    // accumulating at the back of the queue during a large offline-sync
    // (e.g. a workspace just hooked up Gmail and 2k inbounds arrive in
    // a single batch — without this, the oldest occurred_at ties up the
    // first N runs while the freshest-but-about-to-purge rows wait).
    const { data: rows, error: fetchErr } = await admin
      .from("lead_timeline_items")
      .select("id, lead_id, subject, snippet_text, metadata_json")
      .eq("event_type", "email_inbound")
      .is("intent", null)
      .order("expires_at", { ascending: true, nullsFirst: false })
      .order("occurred_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchErr) {
      logger.error("classify_inbound_fetch_failed", { error: fetchErr.message });
      return new Response(
        JSON.stringify({ ok: false, error: fetchErr.message, ...counts }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const batch = (rows ?? []) as TimelineRow[];
    counts.fetched = batch.length;

    if (batch.length === 0) {
      logger.info("classify_inbound_empty_batch", {
        duration_ms: Date.now() - startedAt,
      });
      return new Response(
        JSON.stringify({ ok: true, ...counts, duration_ms: Date.now() - startedAt }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Single bulk lead-context fetch keeps per-row work tight.
    const leadIds = Array.from(
      new Set(batch.map((r) => r.lead_id).filter((id): id is string => !!id)),
    );
    const leadById = new Map<string, LeadRow>();
    if (leadIds.length > 0) {
      const { data: leads, error: leadErr } = await admin
        .from("leads")
        .select("id, name, company")
        .in("id", leadIds);
      if (leadErr) {
        // Non-fatal — we can still classify on email subject + sender alone.
        logger.warn("classify_inbound_lead_fetch_failed", { error: leadErr.message });
      }
      for (const l of ((leads ?? []) as LeadRow[])) leadById.set(l.id, l);
    }

    for (const row of batch) {
      try {
        const emailText = buildEmailText(row);

        if (!emailText) {
          // No subject, no sender, no body. Write `unknown` so the
          // cron stops re-polling this row.
          const { error: updErr } = await admin
            .from("lead_timeline_items")
            .update({
              intent: NO_SIGNAL_INTENT,
              intent_version: INTENT_VERSION,
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id)
            .is("intent", null);
          if (updErr) {
            logger.error("classify_inbound_no_signal_update_failed", {
              row_id: row.id,
              error: updErr.message,
            });
            counts.failed++;
          } else {
            counts.classified++;
            counts.no_signal++;
          }
          continue;
        }

        const leadContext = buildLeadContext(
          row.lead_id ? leadById.get(row.lead_id) : undefined,
        );

        const aiRes = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            task: "intent_router",
            payload: {
              lead_context: leadContext,
              email_text: emailText,
            },
          }),
        });

        if (!aiRes.ok) {
          logger.warn("classify_inbound_ai_http_error", {
            row_id: row.id,
            status: aiRes.status,
          });
          counts.failed++;
          continue;
        }

        const aiData = (await aiRes.json()) as { ok?: boolean; content?: string };
        if (!aiData?.ok || typeof aiData.content !== "string" || !aiData.content) {
          logger.warn("classify_inbound_ai_no_content", { row_id: row.id });
          counts.failed++;
          continue;
        }

        const classification = extractClassification(aiData.content);
        if (!classification) {
          // Parse failure, out-of-vocab intent, or missing intent.
          // Leave intent NULL so a future run (or a future classifier
          // version) can retry. Atomic-or-nothing: we never write one
          // field without the other being parseable.
          //
          // NOTE: intent_router does not currently return a confidence
          // score per its prompt schema, so the low-confidence-→-NULL
          // branch described in earlier briefs reduces to "parse failed
          // → NULL" here. If/when the prompt gains `confidence`, add
          // a threshold check and route low-confidence results through
          // the same NULL path.
          logger.warn("classify_inbound_ai_parse_failed", {
            row_id: row.id,
            content_preview: aiData.content.slice(0, 120),
          });
          counts.failed++;
          continue;
        }

        const { intent: intentPrimary, ai_summary } = classification;

        // Build the metadata_json merge payload. Only merge ai_summary
        // when it's a non-empty string AND the intent is not in the
        // skip list (auto-replies / calendar acks / bounces never need
        // a body summary). Preserves existing fields (from_email,
        // to_emails, ...) via row-level spread.
        const shouldWriteSummary =
          ai_summary !== null && !SKIP_AI_SUMMARY_INTENTS.has(intentPrimary);

        const nextMetadata = shouldWriteSummary
          ? { ...(row.metadata_json ?? {}), ai_summary }
          : undefined;

        // Single UPDATE — intent + (optional) ai_summary land together
        // or not at all. The `.is("intent", null)` guard makes
        // concurrent runs idempotent: the loser silently no-ops.
        const updatePayload: Record<string, unknown> = {
          intent: intentPrimary,
          intent_version: INTENT_VERSION,
          updated_at: new Date().toISOString(),
        };
        if (nextMetadata !== undefined) {
          updatePayload.metadata_json = nextMetadata;
        }

        const { error: updErr } = await admin
          .from("lead_timeline_items")
          .update(updatePayload)
          .eq("id", row.id)
          .is("intent", null);

        if (updErr) {
          logger.error("classify_inbound_update_failed", {
            row_id: row.id,
            intent: intentPrimary,
            error: updErr.message,
          });
          counts.failed++;
          continue;
        }

        counts.classified++;
      } catch (err) {
        // Hard guarantee: this catch is the last line of defence. Any
        // thrown error from ai_task fetch, JSON parsing, or the
        // supabase client lands here and the batch keeps going.
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("classify_inbound_row_unexpected_error", {
          row_id: row.id,
          error: msg,
        });
        counts.failed++;
      }
    }

    logger.info("classify_inbound_batch_done", {
      duration_ms: Date.now() - startedAt,
      ...counts,
    });

    return new Response(
      JSON.stringify({ ok: true, ...counts, duration_ms: Date.now() - startedAt }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("classify_inbound_fatal", { error: msg, ...counts });
    return new Response(
      JSON.stringify({ ok: false, error: msg, ...counts }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
