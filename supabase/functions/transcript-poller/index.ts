// ============================================================
// transcript-poller — Phase 2 step 5
//
// Cron-driven scanner that finds recently-ended meetings missing
// a ready transcript and dispatches per-meeting fetcher calls.
// Also expires meeting_transcripts rows whose calendar_event
// ended more than 24h ago — those are surfaced via the Meetings
// Inbox tab (step 7), not the lead timeline.
//
// AUTH: scheduled-caller gate only — INTERNAL_API_SECRET or
// service-role bearer. Not user-facing.
//
// Dispatched by pg_cron via cron-dispatcher (target:
// "transcript-poller"), every 15 minutes.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Maps calendar_events.platform → the internal fetcher function for
// that provider. Adding "teams" in step 4 is a one-line change here.
const PROVIDER_TO_FETCH_FN: Record<string, string> = {
  google_meet: "meet-transcript-fetch",
  teams: "teams-transcript-fetch",
};

const DEFAULT_PROVIDERS = ["google_meet"];
const STUCK_FETCHING_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MIN = 60;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_ANALYZE_PER_RUN = 5;

interface TranscriptEmbed {
  id: string;
  status: string;
  fetch_attempts: number | null;
  last_attempt_at: string | null;
}

interface EventRow {
  id: string;
  platform: string | null;
  end_time: string | null;
  meeting_transcripts: TranscriptEmbed[] | null;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  if (req.method !== "POST") {
    return jsonResp({ ok: false, error: "Method not allowed" }, 405);
  }

  const startedAt = Date.now();

  let parsedBody: { providers?: unknown } = {};
  try {
    const text = await req.text();
    if (text.length > 0) parsedBody = JSON.parse(text);
  } catch {
    return jsonResp({ ok: false, error: "Invalid JSON body" }, 400);
  }

  let providers: string[] = DEFAULT_PROVIDERS;
  if (Array.isArray(parsedBody.providers)) {
    const filtered = parsedBody.providers.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    if (filtered.length > 0) providers = filtered;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");
  if (!internalSecret) {
    console.error("[transcript-poller] INTERNAL_API_SECRET not configured");
    return jsonResp({ ok: false, error: "Internal error" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  let stage = "init";
  let dispatched = 0;
  let skipped_backoff = 0;
  let expired_24h = 0;
  let analyze_dispatched = 0;
  let analyze_errors = 0;
  let errors = 0;

  try {
    // ── Phase 1: load candidates ──────────────────────────────────────
    stage = "load_candidates";
    const now = Date.now();
    const windowStart = new Date(now - TWENTY_FOUR_HOURS_MS).toISOString();
    const windowEnd = new Date(now).toISOString();

    const { data: rawEvents, error: eventsErr } = await supabase
      .from("calendar_events")
      .select(
        "id, platform, end_time, meeting_transcripts(id, status, fetch_attempts, last_attempt_at)",
      )
      .in("platform", providers)
      .gte("end_time", windowStart)
      .lte("end_time", windowEnd)
      .not("lead_id", "is", null)
      .order("end_time", { ascending: true });

    if (eventsErr) {
      throw new Error(`calendar_events query failed: ${eventsErr.message}`);
    }

    const events = (rawEvents ?? []) as unknown as EventRow[];

    // ── Phase 1: dispatch loop ────────────────────────────────────────
    stage = "dispatch_loop";
    for (const ev of events) {
      const platform = ev.platform;
      if (!platform) continue;

      const transcripts = ev.meeting_transcripts ?? [];
      const mt = transcripts.length > 0 ? transcripts[0] : null;

      // Eligibility: no transcript row yet, OR a retry-eligible status.
      // ready / unavailable / failed are terminal — skip those silently.
      if (mt && !(mt.status === "pending" || mt.status === "fetching")) {
        continue;
      }

      // Backoff guard.
      if (mt && (mt.fetch_attempts ?? 0) > 0) {
        const attempts = mt.fetch_attempts ?? 0;
        const backoffMin = Math.min(attempts * 5, MAX_BACKOFF_MIN);
        const lastAttemptMs = mt.last_attempt_at
          ? new Date(mt.last_attempt_at).getTime()
          : 0;
        const ageMs = now - lastAttemptMs;
        // Stuck-fetching escape hatch: status='fetching' but the in-flight
        // run hasn't updated in >5min — assume it died and proceed anyway.
        const stuckFetching =
          mt.status === "fetching" && ageMs > STUCK_FETCHING_MS;
        if (!stuckFetching && ageMs < backoffMin * 60 * 1000) {
          skipped_backoff++;
          continue;
        }
      }

      const fetchFn = PROVIDER_TO_FETCH_FN[platform];
      if (!fetchFn) {
        // platform present in query but no fetcher wired up yet (e.g. teams
        // before step 4). Skip without counting as an error.
        continue;
      }

      // Sequential dispatch — await each call before starting the next.
      const targetUrl = `${supabaseUrl}/functions/v1/${fetchFn}`;
      try {
        const resp = await fetch(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": internalSecret,
          },
          body: JSON.stringify({ calendarEventId: ev.id }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          errors++;
          console.error(
            "[transcript-poller] dispatch_failed",
            JSON.stringify({
              calendarEventId: ev.id,
              target: fetchFn,
              status: resp.status,
              body: body.slice(0, 200),
            }),
          );
          continue;
        }
        await resp.text().catch(() => "");
        dispatched++;
      } catch (err) {
        errors++;
        console.error(
          "[transcript-poller] dispatch_error",
          JSON.stringify({
            calendarEventId: ev.id,
            target: fetchFn,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // ── Phase 1.5: analyze sweep ──────────────────────────────────────
    // Ready transcripts that don't yet have a meeting_ai_summaries row
    // (UNIQUE on meeting_transcript_id) get dispatched to the analyzer.
    // Window mirrors Phase 1: only recent transcripts (ready in the last
    // 24h) — older ones gracefully time out instead of retrying forever.
    // The analyzer is idempotent, so a duplicate dispatch is cheap.
    stage = "analyze_sweep";
    const analyzeWindowStart = new Date(now - TWENTY_FOUR_HOURS_MS).toISOString();
    const { data: readyRaw, error: readyErr } = await supabase
      .from("meeting_transcripts")
      .select("id, meeting_ai_summaries(id)")
      .eq("status", "ready")
      .gte("ready_at", analyzeWindowStart)
      .order("ready_at", { ascending: true });
    if (readyErr) {
      throw new Error(`analyze sweep lookup failed: ${readyErr.message}`);
    }

    const analyzeUrl = `${supabaseUrl}/functions/v1/meeting-transcript-analyze`;
    let analyze_capped = false;
    for (const row of (readyRaw ?? []) as Array<{ id: string; meeting_ai_summaries: Array<{ id: string }> | null }>) {
      // Skip transcripts that already have a summary row.
      const summaries = row.meeting_ai_summaries ?? [];
      if (summaries.length > 0) continue;

      // Per-run cap: a backlog should drain over several poller cycles
      // rather than starving Phase 2 / exhausting the function timeout.
      if (analyze_dispatched + analyze_errors >= MAX_ANALYZE_PER_RUN) {
        analyze_capped = true;
        break;
      }

      try {
        const resp = await fetch(analyzeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": internalSecret,
          },
          body: JSON.stringify({ meetingTranscriptId: row.id }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          analyze_errors++;
          console.error(
            "[transcript-poller] analyze_dispatch_failed",
            JSON.stringify({
              meetingTranscriptId: row.id,
              status: resp.status,
              body: body.slice(0, 200),
            }),
          );
          continue;
        }
        await resp.text().catch(() => "");
        analyze_dispatched++;
      } catch (err) {
        analyze_errors++;
        console.error(
          "[transcript-poller] analyze_dispatch_error",
          JSON.stringify({
            meetingTranscriptId: row.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // ── Phase 2: 24h-timeout sweep ────────────────────────────────────
    stage = "expired_sweep";
    const expiredCutoff = new Date(now - TWENTY_FOUR_HOURS_MS).toISOString();
    const { data: stuckRaw, error: stuckErr } = await supabase
      .from("meeting_transcripts")
      .select("id, calendar_events!inner(end_time)")
      .in("status", ["pending", "fetching"])
      .lt("calendar_events.end_time", expiredCutoff);
    if (stuckErr) {
      throw new Error(`expired sweep lookup failed: ${stuckErr.message}`);
    }
    const stuckIds = (stuckRaw ?? []).map((r: { id: string }) => r.id);
    if (stuckIds.length > 0) {
      const { data: updated, error: updateErr } = await supabase
        .from("meeting_transcripts")
        .update({ status: "unavailable", status_reason: "EXPIRED_24H" })
        .in("id", stuckIds)
        .in("status", ["pending", "fetching"])
        .select("id");
      if (updateErr) {
        throw new Error(`expired sweep update failed: ${updateErr.message}`);
      }
      expired_24h = updated?.length ?? 0;
    }

    // ── Phase 3: return summary ───────────────────────────────────────
    const durationMs = Date.now() - startedAt;
    const summary = {
      ok: true,
      dispatched,
      skipped_backoff,
      expired_24h,
      analyze_dispatched,
      analyze_errors,
      analyze_capped,
      errors,
      durationMs,
    };
    console.log("[transcript-poller] run_complete", JSON.stringify(summary));
    return jsonResp(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      "[transcript-poller] unexpected_error",
      JSON.stringify({ stage, error: message }),
    );
    return jsonResp({ ok: false, error: "Internal error" }, 500);
  }
});
