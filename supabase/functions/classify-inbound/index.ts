// ============================================================
// classify-inbound — Phase 2a AI classifier cron
//
// Picks up `lead_timeline_items` rows where:
//   • event_type = 'email_inbound'
//   • intent IS NULL
// and classifies each — FIRST with the deterministic detector chain
// (`_shared/inboundIntentDetectors.ts`), and only when that finds
// nothing via `ai_task.intent_router`, writing the
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
// Deterministic-first (the P1 fix): the AI's vocabulary
// (book_meeting, pricing, …) is DISJOINT from the vocabulary the Queue
// hides on (bounce, ooo_reply, calendar_accept, zoom_recap,
// meeting_confirmation, unsubscribe). Before this change only the
// one-shot Phase-1 backfill ever wrote a hide intent, so every bounce
// / OOO / calendar accept that arrived afterwards rendered in the
// Queue as a normal "reply needed" card. Running the same detectors
// the backfill used, in the same precedence order, ahead of the AI
// call makes the hide list reachable again — and saves an AI call on
// every routine auto-reply.
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
import { detectInboundIntent } from "../_shared/inboundIntentDetectors.ts";

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

// Code-state marker for inbound ai_summary writes. Stored alongside
// ai_summary in metadata_json so backfill jobs can identify rows that
// need re-summarizing whenever the summary-producing code path changes
// meaningfully. Kept in lock-step with the constant in
// backfill-inbound-summaries — bumping there without bumping here
// would force the backfill to re-process every freshly classified
// inbound on its first run.
//
// v4 — fix Outlook refetch in backfill (ConsistencyLevel header).
// v3 — added Outlook refetch + multi-line synth fallback in backfill.
// v2 — initial pilot (length-scaled bullet prompt).
const AI_SUMMARY_VERSION = "inbound_summary/v4";

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
  email: string | null;
}

interface BatchCounts {
  fetched: number;
  classified: number;
  failed: number;
  skipped: number;
  /** Subset of classified — rows that got the NO_SIGNAL_INTENT fallback. */
  no_signal: number;
  /** Subset of classified — matched a deterministic detector, no AI call. */
  deterministic: number;
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
  /**
   * The rest of the intent_router JSON schema. The model has been
   * returning these on every call (and we have been paying for them)
   * since the prompt was written; until now they were parsed away and
   * dropped on the floor. They are persisted into `metadata_json` so
   * the Queue can hide non-reply-worthy noise and v2 can rank on
   * urgency / tone without a second AI round-trip.
   *
   * Every field is optional: a model that omits one must NOT fail the
   * row (the atomic-or-nothing rule covers `intent` + `ai_summary`
   * only — those two are what the 72h purge gate depends on).
   */
  signals: AiSignals;
}

/** Persisted verbatim under `metadata_json.ai_signals`. */
interface AiSignals {
  reply_worthy?: boolean;
  urgency?: string;
  tone?: string;
  questions_extracted?: string[];
  /**
   * ISO 639-1 code of the language the sender wrote in, requested by
   * `PROMPTS.intent_router`. Rows classified before that field was added
   * to the schema simply don't carry it — the parser omits what isn't
   * there rather than guessing.
   */
  language?: string;
}

const URGENCY_VALUES = new Set(["high", "medium", "low"]);
const TONE_VALUES = new Set(["positive", "neutral", "negative"]);

/**
 * Pull the four already-paid-for signals (+ language) out of the parsed
 * AI JSON. Defensive by design — anything malformed is simply omitted.
 */
function extractSignals(parsed: Record<string, unknown>): AiSignals {
  const out: AiSignals = {};

  if (typeof parsed.reply_worthy === "boolean") out.reply_worthy = parsed.reply_worthy;

  if (typeof parsed.urgency === "string") {
    const u = parsed.urgency.trim().toLowerCase();
    if (URGENCY_VALUES.has(u)) out.urgency = u;
  }

  if (typeof parsed.tone === "string") {
    const t = parsed.tone.trim().toLowerCase();
    if (TONE_VALUES.has(t)) out.tone = t;
  }

  if (Array.isArray(parsed.questions_extracted)) {
    const qs = parsed.questions_extracted
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter((q) => q.length > 0)
      // Bounded: questions are rendered on a card, and metadata_json is
      // preserved indefinitely (it survives the 72h body purge).
      .slice(0, 10)
      .map((q) => q.slice(0, 300));
    if (qs.length > 0) out.questions_extracted = qs;
  }

  if (typeof parsed.language === "string") {
    const l = parsed.language.trim().toLowerCase();
    if (l.length > 0 && l.length <= 32) out.language = l;
  }

  return out;
}

/**
 * Cheap sender-identity check: did the person we think we're selling to
 * actually send this, or was it their colleague / assistant / a vendor
 * on the thread? Returns `null` when we can't tell.
 *
 * ponytail: compares `from_email` against `leads.email` only. `contacts`
 * has no email column in this schema (identities live outside the row we
 * fetch), so "a known contact on that lead" is not checkable without a
 * second join we don't have. Ceiling: a lead who writes from an alias
 * (j.smith@ vs john.smith@) reads as `false`. Upgrade path: match on the
 * lead's contact identities once they carry addresses. Failing to know
 * is expressed as `null` (never `false`), and the Queue treats `null` as
 * "not hidden", so the check can only ever be additive.
 */
function senderIsLead(fromEmail: string, leadEmail: string | null | undefined): boolean | null {
  const from = normalizeEmail(fromEmail);
  const lead = normalizeEmail(leadEmail ?? "");
  if (!from || !lead) return null;
  return from === lead;
}

/** Lowercase + strip any RFC-2822 `Name <addr>` wrapper. */
function normalizeEmail(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const angle = s.match(/<([^>]+)>/);
  return (angle ? angle[1] : s).trim().toLowerCase();
}

/** `from_email` off the timeline row's metadata, if present. */
function fromEmailOf(row: TimelineRow): string {
  return typeof row.metadata_json?.from_email === "string"
    ? (row.metadata_json.from_email as string).trim()
    : "";
}

/**
 * Robustly extract a JSON object from an AI response that may be:
 *  - wrapped in ```json … ``` markdown fences
 *  - prefixed/suffixed with prose
 *  - truncated mid-object (we attempt to recover the longest balanced prefix)
 */
function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip markdown code fences (```json … ``` or plain ```).
  let s = raw
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  // Direct parse first.
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }

  // Locate the first object.
  const start = s.indexOf("{");
  if (start === -1) return null;
  s = s.slice(start);

  // Try the greedy {…} slice first.
  const greedyEnd = s.lastIndexOf("}");
  if (greedyEnd > 0) {
    try {
      const v = JSON.parse(s.slice(0, greedyEnd + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  // Walk forward and find every balanced closing brace; try parsing each candidate
  // from longest to shortest. Handles truncation by recovering the longest valid prefix.
  const candidates: number[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) candidates.push(i);
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(s.slice(0, candidates[i] + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

function extractClassification(content: string): Classification | null {
  const parsed = tryParseJsonObject(content) as {
    intent_primary?: unknown;
    ai_summary?: unknown;
  } | null;
  if (!parsed) return null;
  if (typeof parsed.intent_primary !== "string") return null;
  const intent = parsed.intent_primary.trim();
  if (!ALLOWED_INTENTS.has(intent)) return null;

  let summary: string | null = null;
  if (typeof parsed.ai_summary === "string") {
    const trimmed = parsed.ai_summary.trim();
    if (trimmed.length > 0) summary = trimmed;
  }

  return {
    intent,
    ai_summary: summary,
    signals: extractSignals(parsed as Record<string, unknown>),
  };
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
    deterministic: 0,
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
        .select("id, name, company, email")
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

        const lead = row.lead_id ? leadById.get(row.lead_id) : undefined;
        const fromEmail = fromEmailOf(row);
        const sender_is_lead = senderIsLead(fromEmail, lead?.email);

        // ── Deterministic detectors FIRST (the P1 fix) ────────────────
        // These emit exactly the six intents the Queue hides on. All six
        // are in SKIP_AI_SUMMARY_INTENTS — no rep ever drafts a reply to
        // a bounce or an OOO — so short-circuiting the AI call here does
        // NOT starve the purge gate of an `ai_summary` it would otherwise
        // have got. (`defer_request` is deliberately excluded from the
        // detector chain for exactly that reason: it IS a human email and
        // must keep flowing to the AI so it gets a durable summary.)
        //
        // No email headers are available on a timeline row, so the OOO
        // header check can't run here — subject + body patterns only,
        // same limitation the Phase-1 backfill documented. The live sync
        // paths still get the header signal.
        const deterministic = detectInboundIntent({
          fromEmail,
          subject: row.subject ?? "",
          body: row.snippet_text ?? "",
        });

        if (deterministic.intent) {
          const { error: detErr } = await admin
            .from("lead_timeline_items")
            .update({
              intent: deterministic.intent,
              intent_version: INTENT_VERSION,
              metadata_json: {
                ...(row.metadata_json ?? {}),
                intent_source: "deterministic",
                sender_is_lead,
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id)
            .is("intent", null);

          if (detErr) {
            logger.error("classify_inbound_deterministic_update_failed", {
              row_id: row.id,
              intent: deterministic.intent,
              error: detErr.message,
            });
            counts.failed++;
          } else {
            counts.classified++;
            counts.deterministic++;
          }
          continue;
        }

        const leadContext = buildLeadContext(lead);

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

        const { intent: intentPrimary, ai_summary, signals } = classification;

        // Atomic-or-nothing enforcement: if the intent is NOT in the
        // skip-list, ai_summary is REQUIRED. A row that parses to a
        // substantive intent but no summary must be treated as a parse
        // failure — otherwise we'd write `intent` and the `intent IS
        // NULL` candidate query would never pick it back up, leaving
        // the row permanently without a durable summary and degrading
        // reply context after the 72h purge.
        //
        // (Codex P1 on PR #49 — without this, a model that drops the
        // ai_summary field for any reason silently produces classified-
        // but-summary-less rows.)
        const isSkipListIntent = SKIP_AI_SUMMARY_INTENTS.has(intentPrimary);
        if (!isSkipListIntent && ai_summary === null) {
          logger.warn("classify_inbound_ai_summary_missing_for_substantive_intent", {
            row_id: row.id,
            intent: intentPrimary,
            content_preview: aiData.content.slice(0, 120),
          });
          counts.failed++;
          continue;
        }

        // Build the metadata_json merge payload. Only merge ai_summary
        // when it's a non-empty string AND the intent is not in the
        // skip list (auto-replies / calendar acks / bounces never need
        // a body summary). Preserves existing fields (from_email,
        // to_emails, ...) via row-level spread.
        //
        // The AI signals (reply_worthy / urgency / tone /
        // questions_extracted / language) and the sender-identity flag
        // ride along on EVERY AI-classified row, summary or not — we
        // already paid for them in the same call.
        const shouldWriteSummary = ai_summary !== null && !isSkipListIntent;

        const nextMetadata: Record<string, unknown> = {
          ...(row.metadata_json ?? {}),
          intent_source: "ai",
          sender_is_lead,
          ai_signals: signals,
        };
        if (shouldWriteSummary) {
          nextMetadata.ai_summary = ai_summary;
          nextMetadata.ai_summary_version = AI_SUMMARY_VERSION;
        }

        // Single UPDATE — intent + (optional) ai_summary land together
        // or not at all. The `.is("intent", null)` guard makes
        // concurrent runs idempotent: the loser silently no-ops.
        const updatePayload: Record<string, unknown> = {
          intent: intentPrimary,
          intent_version: INTENT_VERSION,
          metadata_json: nextMetadata,
          updated_at: new Date().toISOString(),
        };

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
