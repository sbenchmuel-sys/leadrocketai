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
    // Null out expired message bodies while keeping metadata intact.
    // This preserves foreign keys (conversation_id, sender_identity_id, workspace_id)
    // and all non-body columns so timeline/analytics remain functional.
    const { data, error } = await supabase
      .from("messages")
      .update({ body_ciphertext: null })
      .lt("expires_at", new Date().toISOString())
      .not("body_ciphertext", "is", null)
      .select("id");

    if (error) {
      console.error("[message-cleanup] Update failed:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const purgedCount = data?.length ?? 0;
    console.log(`[message-cleanup] Purged ${purgedCount} expired message bodies`);

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
      JSON.stringify({ ok: true, purged: purgedCount, cron_logs_purged: logsPurged }),
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

