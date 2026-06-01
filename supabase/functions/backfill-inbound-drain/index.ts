// ============================================================
// backfill-inbound-drain — one-shot loop driver for
// `backfill-inbound-summaries`.
//
// Calls the backfill function in a loop until it returns
// `fetched: 0` (drained) or a safety cap is hit. Aggregates the
// per-batch counts and returns one summary response.
//
// Auth: X-Internal-Secret only. Same secret as the other internal
// cron/backfill endpoints.
//
// Optional `?workspace_id=<uuid>` is forwarded to each batch call
// so the operator can drain one workspace at a time.
//
// This is a manual remediation tool — not scheduled, not idempotent
// beyond what the underlying batch already provides. Safe to re-run.
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Safety caps. The underlying batch is 50 rows; this gives us up to
// 60 * 50 = 3000 rows per invocation, comfortably above the ~918 row
// backlog. The function bails earlier on consecutive empty/error
// batches so it never spins.
const MAX_BATCHES = 60;
const MAX_DURATION_MS = 50 * 1000;
const SLEEP_BETWEEN_BATCHES_MS = 250;

interface BatchResult {
  ok: boolean;
  error?: string;
  fetched?: number;
  body_present?: number;
  gmail_refetched?: number;
  outlook_refetched?: number;
  subject_synth?: number;
  failed?: number;
  skipped?: number;
  duration_ms?: number;
}

interface Totals {
  batches: number;
  fetched: number;
  body_present: number;
  gmail_refetched: number;
  outlook_refetched: number;
  subject_synth: number;
  failed: number;
  skipped: number;
  errors: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");
  const provided = req.headers.get("X-Internal-Secret");
  if (!internalSecret || provided !== internalSecret) {
    return new Response(
      JSON.stringify({ ok: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing SUPABASE_URL / SERVICE_ROLE_KEY" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const inUrl = new URL(req.url);
  const workspaceId = inUrl.searchParams.get("workspace_id");
  const qs = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : "";
  const targetUrl = `${supabaseUrl}/functions/v1/backfill-inbound-summaries${qs}`;

  const totals: Totals = {
    batches: 0,
    fetched: 0,
    body_present: 0,
    gmail_refetched: 0,
    outlook_refetched: 0,
    subject_synth: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
  };

  const startedAt = Date.now();
  let stopReason: "drained" | "max_batches" | "timeout" | "error_streak" = "drained";
  let consecutiveErrors = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    if (Date.now() - startedAt > MAX_DURATION_MS) {
      stopReason = "timeout";
      break;
    }

    let batch: BatchResult;
    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceKey}`,
          "X-Internal-Secret": internalSecret,
        },
        body: JSON.stringify({}),
      });
      batch = (await res.json()) as BatchResult;
    } catch (err) {
      consecutiveErrors++;
      totals.errors++;
      console.warn(
        `[drain] batch ${i} fetch error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (consecutiveErrors >= 3) {
        stopReason = "error_streak";
        break;
      }
      continue;
    }

    totals.batches++;

    if (!batch.ok) {
      consecutiveErrors++;
      totals.errors++;
      console.warn(`[drain] batch ${i} returned !ok: ${batch.error ?? "unknown"}`);
      if (consecutiveErrors >= 3) {
        stopReason = "error_streak";
        break;
      }
      continue;
    }

    consecutiveErrors = 0;

    const fetched = batch.fetched ?? 0;
    totals.fetched          += fetched;
    totals.body_present     += batch.body_present     ?? 0;
    totals.gmail_refetched  += batch.gmail_refetched  ?? 0;
    totals.outlook_refetched += batch.outlook_refetched ?? 0;
    totals.subject_synth    += batch.subject_synth    ?? 0;
    totals.failed           += batch.failed           ?? 0;
    totals.skipped          += batch.skipped          ?? 0;

    console.log(
      `[drain] batch ${i}: fetched=${fetched} body=${batch.body_present ?? 0} ` +
      `gmail=${batch.gmail_refetched ?? 0} outlook=${batch.outlook_refetched ?? 0} ` +
      `synth=${batch.subject_synth ?? 0} failed=${batch.failed ?? 0}`,
    );

    if (fetched === 0) {
      stopReason = "drained";
      break;
    }

    // Small pause to avoid hammering the AI gateway / Graph / Gmail.
    await new Promise((r) => setTimeout(r, SLEEP_BETWEEN_BATCHES_MS));

    if (i === MAX_BATCHES - 1) stopReason = "max_batches";
  }

  return new Response(
    JSON.stringify({
      ok: true,
      stop_reason: stopReason,
      duration_ms: Date.now() - startedAt,
      workspace_id: workspaceId,
      ...totals,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
