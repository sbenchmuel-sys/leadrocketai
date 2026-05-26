// ============================================================
// intelligence-queue-drain — Drain auto-recompute queue
//
// Called every 5 min by cron-dispatcher (target=intelligence-queue-drain).
// Pops up to BATCH_SIZE leads from `lead_intelligence_recompute_queue`
// (oldest first) and calls `recompute-lead-intelligence` for each.
//
// The trigger-side ON CONFLICT (lead_id) DO NOTHING means N signals
// arriving for the same lead between drain ticks cost exactly ONE
// recompute — that's the cost-cap mechanism.
//
// AUTH: privileged callers only (cron-dispatcher with X-Internal-Secret,
// or direct service-role invocation for ops/backfill).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requirePrivilegedCaller } from "../_shared/authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const BATCH_SIZE = 15;            // recompute is heavier than classify; smaller batch
const MAX_ATTEMPTS = 5;           // give up after this many failures
const PER_LEAD_TIMEOUT_MS = 25_000;
const OVERALL_BUDGET_MS = 50_000; // stay under the 55s edge function cap

interface QueueRow {
  lead_id: string;
  workspace_id: string;
  queued_at: string;
  source: string;
  attempts: number;
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const denied = requirePrivilegedCaller(req, corsHeaders);
  if (denied) return denied;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const internalSecret = Deno.env.get("INTERNAL_API_SECRET")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const startedAt = Date.now();
  const results: Array<{ lead_id: string; status: "ok" | "failed" | "skipped"; error?: string }> = [];

  // ── Drop rows that have exhausted retries (keeps the queue from getting stuck) ──
  const { data: exhausted } = await admin
    .from("lead_intelligence_recompute_queue")
    .delete()
    .gte("attempts", MAX_ATTEMPTS)
    .select("lead_id");
  if (exhausted && exhausted.length > 0) {
    console.warn(
      `[intelligence-queue-drain] Dropped ${exhausted.length} exhausted rows:`,
      exhausted.map(r => r.lead_id).join(",")
    );
  }

  // ── Fetch the next batch (oldest first) ──
  const { data: batch, error: fetchErr } = await admin
    .from("lead_intelligence_recompute_queue")
    .select("lead_id, workspace_id, queued_at, source, attempts")
    .order("queued_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error("[intelligence-queue-drain] Queue fetch failed:", fetchErr.message);
    return jsonResp({ ok: false, error: fetchErr.message }, 500);
  }

  if (!batch || batch.length === 0) {
    return jsonResp({ ok: true, processed: 0, queue_empty: true });
  }

  console.log(`[intelligence-queue-drain] Processing ${batch.length} leads`);

  // ── Process each lead, respecting the overall time budget ──
  for (const row of batch as QueueRow[]) {
    if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
      console.warn("[intelligence-queue-drain] Time budget reached — bailing");
      break;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_LEAD_TIMEOUT_MS);

    try {
      const resp = await fetch(`${supabaseUrl}/functions/v1/recompute-lead-intelligence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": internalSecret,
        },
        body: JSON.stringify({ lead_id: row.lead_id }),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const bodyText = await resp.text();

      if (resp.ok) {
        // Success — remove the queue row.
        await admin
          .from("lead_intelligence_recompute_queue")
          .delete()
          .eq("lead_id", row.lead_id);
        results.push({ lead_id: row.lead_id, status: "ok" });
      } else {
        const errSnippet = bodyText.slice(0, 500);
        await admin
          .from("lead_intelligence_recompute_queue")
          .update({
            attempts: row.attempts + 1,
            last_attempt_at: new Date().toISOString(),
            last_error: errSnippet,
          })
          .eq("lead_id", row.lead_id);
        results.push({ lead_id: row.lead_id, status: "failed", error: errSnippet });
        console.error(`[intelligence-queue-drain] Recompute failed for ${row.lead_id}: ${errSnippet}`);
      }
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      await admin
        .from("lead_intelligence_recompute_queue")
        .update({
          attempts: row.attempts + 1,
          last_attempt_at: new Date().toISOString(),
          last_error: isAbort ? "timeout" : message.slice(0, 500),
        })
        .eq("lead_id", row.lead_id);
      results.push({ lead_id: row.lead_id, status: "failed", error: isAbort ? "timeout" : message });
      console.error(`[intelligence-queue-drain] Recompute threw for ${row.lead_id}:`, message);
    }
  }

  const okCount = results.filter(r => r.status === "ok").length;
  const failedCount = results.filter(r => r.status === "failed").length;
  const durationMs = Date.now() - startedAt;

  console.log(
    `[intelligence-queue-drain] Drained ${results.length} / ${batch.length} ` +
    `(ok=${okCount} failed=${failedCount}) in ${durationMs}ms`
  );

  return jsonResp({
    ok: true,
    processed: results.length,
    batch_size: batch.length,
    ok_count: okCount,
    failed_count: failedCount,
    duration_ms: durationMs,
    results,
  });
});
