import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // AUTH: Only cron-dispatcher / service-role callers
  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Delegate the actual purge to `expire_old_messages()` — the SQL
    // function is the single source of truth for the classification-
    // gated purge logic (see migration `_purge_gate_classified.sql`).
    // The edge function is a thin wrapper that just invokes it and
    // structures the response, so the gate logic can't drift between
    // the application-layer cron path and the DB-level fallback cron.
    //
    // Purges across the three tables that hold raw bodies:
    //   - messages.body_ciphertext        — WhatsApp / SMS (unconditional 72h)
    //   - interactions.body_text          — email body (gated on paired timeline
    //                                       row's intent OR 7-day hard cap)
    //   - lead_timeline_items.snippet_text — email snippet (gated on this row's
    //                                       own intent OR 7-day hard cap)
    // Metadata (FKs, subjects, ai_summary, timestamps) is preserved so
    // timeline/analytics keep working after the body is gone.
    const { data: purgeRows, error: purgeErr } = await supabase.rpc(
      "expire_old_messages",
    );

    if (purgeErr) {
      console.error("[message-cleanup] expire_old_messages RPC failed:", purgeErr);
      return new Response(JSON.stringify({ error: purgeErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RPC returns a single-row TABLE — Supabase serializes that as an array.
    const purge = (Array.isArray(purgeRows) ? purgeRows[0] : purgeRows) as {
      messages_purged?: number;
      interactions_purged?: number;
      lead_timeline_items_purged?: number;
    } | null;
    const messagesPurged = purge?.messages_purged ?? 0;
    const interactionsPurged = purge?.interactions_purged ?? 0;
    const timelinePurged = purge?.lead_timeline_items_purged ?? 0;
    console.log(
      `[message-cleanup] Purged bodies — messages: ${messagesPurged}, ` +
        `interactions: ${interactionsPurged}, lead_timeline_items: ${timelinePurged}`
    );

    // Also clean up old cron_run_log entries (>30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: oldLogs } = await supabase
      .from("cron_run_log")
      .delete()
      .lt("started_at", thirtyDaysAgo)
      .select("id");
    const logsPurged = oldLogs?.length ?? 0;
    if (logsPurged > 0) {
      console.log(`[message-cleanup] Purged ${logsPurged} old cron_run_log entries`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        purged: {
          messages: messagesPurged,
          interactions: interactionsPurged,
          lead_timeline_items: timelinePurged,
        },
        cron_logs_purged: logsPurged,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[message-cleanup] Unexpected error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

