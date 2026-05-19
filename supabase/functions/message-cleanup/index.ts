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
    const nowIso = new Date().toISOString();

    // Null out expired raw bodies across the three tables that hold them:
    //   - messages.body_ciphertext        — WhatsApp / SMS (encrypted)
    //   - interactions.body_text          — email body (plaintext)
    //   - lead_timeline_items.snippet_text — email body snippet (plaintext)
    // Metadata (FKs, subjects, ai_summary, timestamps) is preserved so
    // timeline/analytics keep working after the body is gone.
    const [messagesRes, interactionsRes, timelineRes] = await Promise.all([
      supabase
        .from("messages")
        .update({ body_ciphertext: null })
        .lt("expires_at", nowIso)
        .not("body_ciphertext", "is", null)
        .select("id"),
      supabase
        .from("interactions")
        .update({ body_text: null })
        .lt("expires_at", nowIso)
        .not("body_text", "is", null)
        .select("id"),
      supabase
        .from("lead_timeline_items")
        .update({ snippet_text: null })
        .lt("expires_at", nowIso)
        .not("snippet_text", "is", null)
        .select("id"),
    ]);

    const firstError = messagesRes.error ?? interactionsRes.error ?? timelineRes.error;
    if (firstError) {
      console.error("[message-cleanup] Update failed:", firstError);
      return new Response(JSON.stringify({ error: firstError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const messagesPurged = messagesRes.data?.length ?? 0;
    const interactionsPurged = interactionsRes.data?.length ?? 0;
    const timelinePurged = timelineRes.data?.length ?? 0;
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

