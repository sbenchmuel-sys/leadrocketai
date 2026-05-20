// ============================================================
// classify-timeline-intent-sample — read-only investigation tool
//
// Phase 1 spot-check helper. The backfill (classify-timeline-intent-
// backfill) populated `lead_timeline_items.intent` for the rows whose
// heuristic detectors fired, and left the rest NULL. This function
// samples both populations and runs every detector against each row
// so a human can audit:
//   • Are the NULL rows genuine "no detector applies" (human replies,
//     ambiguous content) — or are the detectors missing rows they
//     should have caught?
//   • Are the classified rows actually what the matched intent says?
//
// Strictly read-only. No UPDATE, no INSERT, no DELETE. Safe to invoke
// at will. Intended as a one-shot manual run via service-role token
// or X-Internal-Secret; not wired into cron-dispatcher.
//
// Output shape (returned as JSON, indent=2):
//   {
//     "null_samples":      [ { from_email, subject, snippet_preview,
//                              detector_results, would_classify_as }, ... ],  // 20 rows
//     "classified_samples":[ { intent, from_email, subject, snippet_preview,
//                              detector_results, would_classify_as }, ... ],  // up to all
//     "totals":            { null_population, classified_population,
//                            null_sampled, classified_sampled }
//   }
//
// `detector_results` is the raw boolean output of each detector run
// independently. `would_classify_as` is the result of the precedence
// chain (bounce > ooo_reply > unsubscribe > defer_request >
// meeting_confirmation > calendar_accept > zoom_recap) — identical to
// the backfill's `classify()`. For correctly-classified rows the
// stored `intent` should equal `would_classify_as`; any mismatch is
// itself a finding.
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

const NULL_SAMPLE_SIZE = 20;
const SNIPPET_PREVIEW_CHARS = 200;
const CLASSIFIED_INTENTS = ["calendar_accept", "ooo_reply"] as const;

type IntentValue =
  | "bounce"
  | "ooo_reply"
  | "unsubscribe"
  | "defer_request"
  | "meeting_confirmation"
  | "calendar_accept"
  | "zoom_recap";

interface DetectorResults {
  ooo: boolean;
  meeting: boolean;
  bounce: boolean;
  unsubscribe: boolean;
  zoom_recap: boolean;
  defer: boolean;
}

interface InteractionRow {
  id: string;
  from_email: string | null;
  subject: string | null;
  body_text: string | null;
  occurred_at: string | null;
}

interface SampleEntry {
  intent?: string | null;
  from_email: string | null;
  subject: string | null;
  snippet_preview: string | null;
  detector_results: DetectorResults;
  would_classify_as: IntentValue | null;
}

function runAllDetectors(row: InteractionRow): DetectorResults {
  const fromEmail = row.from_email ?? "";
  const subject = row.subject ?? "";
  const body = row.body_text ?? "";
  const bodyLower = body.toLowerCase();
  const occurredAt = row.occurred_at ? new Date(row.occurred_at) : new Date();

  return {
    bounce: detectBounce(fromEmail, subject).isBounce,
    // OOO header check is unavailable here (interactions doesn't persist
    // headers), so subject + body patterns only. Matches the backfill.
    ooo: isOutOfOfficeReply([], subject, body).isOOO,
    unsubscribe: body ? isHumanUnsubscribeRequest(bodyLower) : false,
    defer: body ? detectDeferSignal(body, occurredAt).isDefer : false,
    meeting: detectMeetingConfirmation(subject, body).isConfirmed,
    zoom_recap: detectZoomRecap(fromEmail, subject, body).isZoomRecap,
  };
}

/** Identical precedence to classify-timeline-intent-backfill.classify(). */
function classifyWithPrecedence(row: InteractionRow): IntentValue | null {
  const fromEmail = row.from_email ?? "";
  const subject = row.subject ?? "";
  const body = row.body_text ?? "";
  const bodyLower = body.toLowerCase();
  const occurredAt = row.occurred_at ? new Date(row.occurred_at) : new Date();

  if (detectBounce(fromEmail, subject).isBounce) return "bounce";
  if (isOutOfOfficeReply([], subject, body).isOOO) return "ooo_reply";
  if (body && isHumanUnsubscribeRequest(bodyLower)) return "unsubscribe";
  if (body) {
    const defer = detectDeferSignal(body, occurredAt);
    if (defer.isDefer && defer.reconnectDate) return "defer_request";
  }
  const meeting = detectMeetingConfirmation(subject, body);
  if (meeting.isConfirmed) {
    return meeting.confidence === "subject"
      ? "calendar_accept"
      : "meeting_confirmation";
  }
  if (detectZoomRecap(fromEmail, subject, body).isZoomRecap) return "zoom_recap";
  return null;
}

function previewSnippet(snippet: string | null): string | null {
  if (snippet === null) return null;
  return snippet.length > SNIPPET_PREVIEW_CHARS
    ? snippet.slice(0, SNIPPET_PREVIEW_CHARS)
    : snippet;
}

/** Fisher-Yates in place. */
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
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

  try {
    // ----- 1. Pull every NULL timeline row (small population, ~322
    // per the latest backfill report). Reduce to one representative
    // source_id per dedupe_key — same grouping the backfill uses so
    // the sample is over distinct emails, not duplicated projections.
    const { data: nullRows, error: nullErr } = await admin
      .from("lead_timeline_items")
      .select("dedupe_key, source_id, snippet_text")
      .is("intent", null)
      .eq("event_type", "email_inbound")
      .eq("source_table", "interactions");

    if (nullErr) throw new Error(`fetch null rows: ${nullErr.message}`);

    const nullByKey = new Map<
      string,
      { source_id: string; snippet_text: string | null }
    >();
    for (const r of nullRows ?? []) {
      const k = r.dedupe_key as string | null;
      const sid = r.source_id as string | null;
      if (!k || !sid) continue;
      if (!nullByKey.has(k)) {
        nullByKey.set(k, {
          source_id: sid,
          snippet_text: (r.snippet_text as string | null) ?? null,
        });
      }
    }

    const nullEntries = Array.from(nullByKey.entries());
    shuffle(nullEntries);
    const nullSampleEntries = nullEntries.slice(0, NULL_SAMPLE_SIZE);

    // ----- 2. Pull every classified-as-{calendar_accept,ooo_reply} row.
    // Population is small (~26), so we take all of them.
    const { data: classifiedRows, error: classifiedErr } = await admin
      .from("lead_timeline_items")
      .select("dedupe_key, source_id, snippet_text, intent")
      .in("intent", CLASSIFIED_INTENTS as unknown as string[])
      .eq("event_type", "email_inbound")
      .eq("source_table", "interactions");

    if (classifiedErr) {
      throw new Error(`fetch classified rows: ${classifiedErr.message}`);
    }

    const classifiedByKey = new Map<
      string,
      { source_id: string; snippet_text: string | null; intent: string }
    >();
    for (const r of classifiedRows ?? []) {
      const k = r.dedupe_key as string | null;
      const sid = r.source_id as string | null;
      const intent = r.intent as string | null;
      if (!k || !sid || !intent) continue;
      if (!classifiedByKey.has(k)) {
        classifiedByKey.set(k, {
          source_id: sid,
          snippet_text: (r.snippet_text as string | null) ?? null,
          intent,
        });
      }
    }

    const classifiedEntries = Array.from(classifiedByKey.entries());

    // ----- 3. Bulk-fetch the interaction bodies for both samples.
    const allSourceIds = [
      ...nullSampleEntries.map(([, v]) => v.source_id),
      ...classifiedEntries.map(([, v]) => v.source_id),
    ];

    const { data: interactions, error: interactionErr } = await admin
      .from("interactions")
      .select("id, from_email, subject, body_text, occurred_at")
      .in("id", allSourceIds);

    if (interactionErr) {
      throw new Error(`fetch interactions: ${interactionErr.message}`);
    }

    const interactionById = new Map<string, InteractionRow>(
      (interactions ?? []).map((r) => [r.id as string, r as InteractionRow]),
    );

    // ----- 4. Assemble the report.
    const buildEntry = (
      sourceId: string,
      snippet: string | null,
      intent: string | null,
    ): SampleEntry | null => {
      const interaction = interactionById.get(sourceId);
      if (!interaction) {
        // Source interaction missing (likely 72h-purged or lead deleted).
        return {
          intent,
          from_email: null,
          subject: null,
          snippet_preview: previewSnippet(snippet),
          detector_results: {
            ooo: false,
            meeting: false,
            bounce: false,
            unsubscribe: false,
            zoom_recap: false,
            defer: false,
          },
          would_classify_as: null,
        };
      }
      return {
        intent,
        from_email: interaction.from_email,
        subject: interaction.subject,
        snippet_preview: previewSnippet(snippet),
        detector_results: runAllDetectors(interaction),
        would_classify_as: classifyWithPrecedence(interaction),
      };
    };

    const null_samples: SampleEntry[] = nullSampleEntries
      .map(([, v]) => buildEntry(v.source_id, v.snippet_text, null))
      .filter((e): e is SampleEntry => e !== null)
      // null rows don't carry an `intent`, drop the field for cleaner JSON
      .map(({ intent: _unused, ...rest }) => rest as SampleEntry);

    const classified_samples: SampleEntry[] = classifiedEntries
      .map(([, v]) => buildEntry(v.source_id, v.snippet_text, v.intent))
      .filter((e): e is SampleEntry => e !== null);

    const report = {
      null_samples,
      classified_samples,
      totals: {
        null_population: nullByKey.size,
        classified_population: classifiedByKey.size,
        null_sampled: null_samples.length,
        classified_sampled: classified_samples.length,
      },
    };

    logger.info("classify_sample_complete", {
      null_population: nullByKey.size,
      classified_population: classifiedByKey.size,
      null_sampled: null_samples.length,
    });

    return new Response(JSON.stringify(report, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("classify_sample_fatal", { error: msg });
    return new Response(
      JSON.stringify({ ok: false, error: msg }, null, 2),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
