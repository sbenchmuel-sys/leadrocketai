import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
    // All metrics are computed in one SQL aggregate (see migration
    // 20261105120000_compute_manager_analytics_sql.sql). This function stays the
    // cron entry point.
    const { data: computed, error } = await supabase.rpc("compute_manager_analytics_sql");
    if (error) throw new Error(error.message);

    console.log(`[compute-manager-analytics] Computed metrics for ${computed} reps`);
    return new Response(
      JSON.stringify({ ok: true, computed }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[compute-manager-analytics] Fatal error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
