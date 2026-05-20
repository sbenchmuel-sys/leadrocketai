// ============================================================
// classify-timeline-intent-backfill — Phase 1
//
// One-shot edge function that populates the new
// `lead_timeline_items.intent` column (see
// 20260520120000_lead_timeline_items_intent.sql) from existing rows
// using the heuristic detectors already in supabase/functions/_shared/.
//
// Auth: requires X-Internal-Secret or service-role token. Intended
// to be invoked manually after Lovable applies the migration.
// NOT wired into cron-dispatcher in this phase.
//
// Algorithm (per EDGE_CASES.md #5 and #12):
//   • Group rows by dedupe_key, NOT by id. A single Gmail/Outlook
//     message_id can project to multiple leads via the same
//     dedupe_key; classifying per row would re-run detectors N times
//     for the same body. We classify once per unique dedupe_key
//     using one representative row's source_id and then UPDATE all
//     rows that share it.
//   • Every UPDATE includes `AND intent IS NULL` so a concurrent
//     live sync write that has already populated intent is never
//     clobbered. 0-row UPDATEs are a soft-skip.
//   • Idempotent — safe to re-run. Each run picks up only rows that
//     are still NULL.
//
// Detector precedence (per EDGE_CASES.md #1) — first match wins:
//   bounce > ooo_reply > unsubscribe > defer_request >
//   meeting_confirmation > calendar_accept > zoom_recap
//
// Notes / known recall limitations:
//   • `interactions` does not persist email HEADERS, so the OOO
//     header check (`Auto-Submitted`, `X-Autoreply`, `Precedence`)
//     cannot be replayed in backfill. OOO classification here uses
//     subject + body patterns only — lower recall than live sync.
//   • `interactions` does not persist `List-Unsubscribe`, so the
//     unsubscribe newsletter-guard cannot be replayed. Subject is
//     unaffected. Real-world false-positive risk is small because
//     `isHumanUnsubscribeRequest` only triggers on explicit phrases.
//   • Rows older than 72 hours have purged body_text per the
//     product commitment (CLAUDE.md). Those still classify on
//     `from_email` + `subject` (catches bounce + most zoom_recap +
//     subject-anchored OOO + `Accepted:`-prefixed calendar_accept).
//
// Out of scope for Phase 1 (per the rollout plan):
//   • Writing intent for non-email rows or outbound emails.
//   • Calling ai_task.intent_router on no-match rows. Those stay
//     NULL and become Phase 2a's job.
//   • Migrating gmail-sync / outlook-sync / process-zoom-summary to
//     import from the new _shared detector modules.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

import { isOutOfOfficeReply, detectDeferSignal } from "../_shared/oooDetection.ts";
import { detectMeetingConfirmation } from "../_shared/meetingConfirmation.ts";
import { isHumanUnsubscribeRequest } from "../_shared/unsubscribeDetection.ts";
import { detectBounce } from "../_shared/bounceDetection.ts";
import { detectZoomRecap } from "../_shared/zoomRecapDetection.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const BATCH_SIZE = 500;
const SLEEP_BETWEEN_BATCHES_MS = 100;
// Cap a single invocation at ~120s wall-clock so we don't hit the
// edge-function timeout. The caller can re-invoke; this function is
// idempotent because every UPDATE filters on intent IS NULL.
const MAX_WALL_CLOCK_MS = 120_000;

type IntentValue =
  | "bounce"
  | "ooo_reply"
  | "unsubscribe"
  | "defer_request"
  | "meeting_confirmation"
  | "calendar_accept"
  | "zoom_recap";

const INTENT_VALUES: IntentValue[] = [
  "bounce",
  "ooo_reply",
  "unsubscribe",
  "defer_request",
  "meeting_confirmation",
  "calendar_accept",
  "zoom_recap",
];

interface InteractionRow {
  id: string;
  from_email: string | null;
  subject: string | null;
  body_text: string | null;
  occurred_at: string | null;
}

/**
 * Apply the documented precedence chain to a single email body.
 * Returns the matched intent or `null` if no detector triggered.
 */
function classify(row: InteractionRow): IntentValue | null {
  const fromEmail = row.from_email ?? "";
  const subject = row.subject ?? "";
  const body = row.body_text ?? "";
  const bodyLower = body.toLowerCase();
  const occurredAt = row.occurred_at ? new Date(row.occurred_at) : new Date();

  // 1. bounce — sender or subject anchors, no body needed
  const bounce = detectBounce(fromEmail, subject);
  if (bounce.isBounce) return "bounce";

  // 2. ooo_reply — header check is unavailable in backfill (see
  // module comment); pass empty headers so the subject + body
  // patterns inside isOutOfOfficeReply still run.
  const ooo = isOutOfOfficeReply([], subject, body);
  if (ooo.isOOO) return "ooo_reply";

  // 3. unsubscribe — body-pattern only; caller normally also guards
  // on the absence of a List-Unsubscribe header, which we cannot
  // replay. Risk is small in practice (phrase list is conservative).
  if (body && isHumanUnsubscribeRequest(bodyLower)) return "unsubscribe";

  // 4. defer_request — "let's reconnect in Q3" etc.
  if (body) {
    const defer = detectDeferSignal(body, occurredAt);
    if (defer.isDefer && defer.reconnectDate) return "defer_request";
  }

  // 5 + 6. meeting confirmation — same detector produces two intents:
  //   confidence === "subject" → calendar_accept   (Accepted: …)
  //   confidence === "body"    → meeting_confirmation (see you Tuesday)
  // Precedence order in the prompt is meeting_confirmation BEFORE
  // calendar_accept, but the detector's own subject branch returns
  // before the body branch and the subject branch IS the
  // calendar_accept case. So in practice:
  //   • Subject `^Accepted:` → calendar_accept (subject branch wins).
  //   • Otherwise body phrase → meeting_confirmation.
  // This matches the live-sync detector's behaviour 1:1.
  const meeting = detectMeetingConfirmation(subject, body);
  if (meeting.isConfirmed) {
    return meeting.confidence === "subject"
      ? "calendar_accept"
      : "meeting_confirmation";
  }

  // 7. zoom_recap — last in precedence per prompt; uses from+subject+body
  const zoom = detectZoomRecap(fromEmail, subject, body);
  if (zoom.isZoomRecap) return "zoom_recap";

  return null;
}

interface RunSummary {
  rows_updated: number;
  counts: Record<string, number>;
  errors_count: number;
  errors: string[];
  batches_processed: number;
  unique_dedupe_keys_seen: number;
  no_match_dedupe_keys: number;
  done: boolean;
  /** When done=false, hint that the caller should re-invoke. */
  reason?: "wall_clock_budget" | "no_more_rows";
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

  const summary: RunSummary = {
    rows_updated: 0,
    counts: { null: 0 },
    errors_count: 0,
    errors: [],
    batches_processed: 0,
    unique_dedupe_keys_seen: 0,
    no_match_dedupe_keys: 0,
    done: false,
  };
  for (const v of INTENT_VALUES) summary.counts[v] = 0;

  const startedAt = Date.now();
  let lastSeenDedupeKey: string | null = null;

  try {
    while (true) {
      if (Date.now() - startedAt > MAX_WALL_CLOCK_MS) {
        summary.done = false;
        summary.reason = "wall_clock_budget";
        break;
      }

      // (a) Pull a batch of representative rows, one per dedupe_key.
      // We use a keyset-style cursor on dedupe_key so successive
      // batches don't overlap. ORDER BY dedupe_key is stable.
      let query = admin
        .from("lead_timeline_items")
        .select("dedupe_key, source_id")
        .is("intent", null)
        .eq("event_type", "email_inbound")
        .eq("source_table", "interactions")
        .order("dedupe_key", { ascending: true })
        .limit(BATCH_SIZE * 4); // over-pull because there may be many rows per dedupe_key

      if (lastSeenDedupeKey !== null) {
        query = query.gt("dedupe_key", lastSeenDedupeKey);
      }

      const { data: batchRows, error: fetchErr } = await query;

      if (fetchErr) {
        summary.errors.push(`fetch batch: ${fetchErr.message}`);
        summary.errors_count++;
        break;
      }

      if (!batchRows || batchRows.length === 0) {
        summary.done = true;
        summary.reason = "no_more_rows";
        break;
      }

      // Reduce to one representative source_id per dedupe_key while
      // preserving the dedupe_key order returned by Postgres.
      const reps = new Map<string, string>(); // dedupe_key -> source_id
      for (const r of batchRows) {
        const k = r.dedupe_key as string | null;
        const sid = r.source_id as string | null;
        if (!k || !sid) continue;
        if (!reps.has(k)) reps.set(k, sid);
        if (reps.size >= BATCH_SIZE) break;
      }

      if (reps.size === 0) {
        summary.done = true;
        summary.reason = "no_more_rows";
        break;
      }

      const dedupeKeys = Array.from(reps.keys());
      const sourceIds = Array.from(reps.values());
      summary.unique_dedupe_keys_seen += dedupeKeys.length;

      // (b) Fetch the interaction bodies for the representatives.
      const { data: interactions, error: interactionErr } = await admin
        .from("interactions")
        .select("id, from_email, subject, body_text, occurred_at")
        .in("id", sourceIds);

      if (interactionErr) {
        summary.errors.push(`fetch interactions: ${interactionErr.message}`);
        summary.errors_count++;
        // Advance cursor so we don't loop on the same broken batch.
        lastSeenDedupeKey = dedupeKeys[dedupeKeys.length - 1];
        continue;
      }

      // Map interaction.id -> classified intent
      const interactionById = new Map<string, InteractionRow>(
        (interactions ?? []).map((r) => [r.id as string, r as InteractionRow]),
      );

      // (c) Bucket dedupe_keys by classified intent (null = no match).
      const bucketsByIntent: Record<string, string[]> = {};
      for (const v of INTENT_VALUES) bucketsByIntent[v] = [];

      for (const [dedupeKey, sourceId] of reps) {
        const interaction = interactionById.get(sourceId);
        if (!interaction) {
          // Source interaction has been deleted (e.g. lead cascade-
          // deleted after we read the timeline row). Soft-skip — the
          // timeline row will also be gone by the time we UPDATE.
          summary.no_match_dedupe_keys++;
          summary.counts.null++;
          continue;
        }
        const intent = classify(interaction);
        if (intent === null) {
          summary.no_match_dedupe_keys++;
          summary.counts.null++;
        } else {
          bucketsByIntent[intent].push(dedupeKey);
        }
      }

      // (d) One UPDATE per intent value covering its bucket of
      // dedupe_keys. `AND intent IS NULL` guards against concurrent
      // live writes (EDGE_CASES.md #12). `AND event_type=
      // 'email_inbound'` mirrors the SELECT scope so we never
      // accidentally bleed onto a row we didn't classify (e.g. a
      // hypothetical future outbound row sharing a dedupe_key).
      for (const intent of INTENT_VALUES) {
        const keys = bucketsByIntent[intent];
        if (keys.length === 0) continue;

        const { error: updErr, count } = await admin
          .from("lead_timeline_items")
          .update({ intent, updated_at: new Date().toISOString() }, { count: "exact" })
          .in("dedupe_key", keys)
          .is("intent", null)
          .eq("event_type", "email_inbound");

        if (updErr) {
          summary.errors.push(
            `update intent=${intent} (${keys.length} keys): ${updErr.message}`,
          );
          summary.errors_count++;
          continue;
        }
        const updated = count ?? 0;
        summary.rows_updated += updated;
        summary.counts[intent] += updated;
      }

      // Advance keyset cursor and sleep before the next batch.
      lastSeenDedupeKey = dedupeKeys[dedupeKeys.length - 1];
      summary.batches_processed++;
      logger.info("classify_backfill_batch", {
        batch: summary.batches_processed,
        unique_keys_this_batch: dedupeKeys.length,
        rows_updated_so_far: summary.rows_updated,
        last_key: lastSeenDedupeKey,
      });

      await new Promise((r) => setTimeout(r, SLEEP_BETWEEN_BATCHES_MS));
    }

    return new Response(JSON.stringify({ ok: true, ...summary }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("classify_backfill_fatal", { error: msg });
    return new Response(
      JSON.stringify({ ok: false, error: msg, ...summary }, null, 2),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
