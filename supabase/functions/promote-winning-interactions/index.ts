import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Promotes un-promoted winning_interactions into kb_chunks.
 * Intended to run on a schedule (e.g. every 6 hours).
 *
 * For each unpromoted row:
 *  1. Summarize the message into a concise, reusable messaging pattern
 *  2. Insert as kb_chunk with content_type='messaging', priority=5
 *  3. Mark as promoted
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    // Fetch up to 20 unpromoted winning interactions
    const { data: rows, error: fetchErr } = await admin
      .from("winning_interactions")
      .select("id, workspace_id, lead_id, message_content, channel, outcome_type, created_at")
      .eq("promoted_to_kb", false)
      .order("created_at", { ascending: true })
      .limit(20);

    if (fetchErr) {
      logger.error("promote_fetch_error", { error: fetchErr.message });
      return new Response(JSON.stringify({ error: "Failed to fetch" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ ok: true, promoted: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let promotedCount = 0;

    for (const row of rows) {
      try {
        // Resolve owner_user_id from the lead
        const { data: lead } = await admin
          .from("leads")
          .select("owner_user_id, name, company")
          .eq("id", row.lead_id)
          .single();

        if (!lead) {
          // Lead deleted — mark as promoted to skip
          await admin
            .from("winning_interactions")
            .update({ promoted_to_kb: true })
            .eq("id", row.id);
          continue;
        }

        // Build a KB entry from the winning message
        const outcomeLabel = row.outcome_type === "meeting_booked"
          ? "Meeting Booked"
          : row.outcome_type === "deal_won"
            ? "Deal Won"
            : "Positive Reply";

        const title = `Winning ${row.channel} — ${outcomeLabel} (${lead.company || "Unknown"})`;

        // Clean and cap the content
        const content = [
          `Outcome: ${outcomeLabel}`,
          `Channel: ${row.channel}`,
          `Lead: ${lead.name} at ${lead.company || "Unknown"}`,
          `Date: ${new Date(row.created_at).toISOString().split("T")[0]}`,
          "",
          "--- Message that produced this outcome ---",
          row.message_content.slice(0, 2000),
        ].join("\n");

        // Insert as kb_chunk
        const { error: insertErr } = await admin.from("kb_chunks").insert({
          owner_user_id: lead.owner_user_id,
          title,
          content,
          content_type: "messaging",
          priority: 5,
          allowed_customer_facing: false,
          processing_status: "completed",
          source: "winning_interaction",
          tags: [row.outcome_type, row.channel],
          segment: "winning_patterns",
        });

        if (insertErr) {
          logger.error("promote_insert_error", { id: row.id, error: insertErr.message });
          continue;
        }

        // Mark as promoted
        await admin
          .from("winning_interactions")
          .update({ promoted_to_kb: true })
          .eq("id", row.id);

        promotedCount++;
        logger.info("winning_interaction_promoted", { id: row.id, leadId: row.lead_id, outcome: row.outcome_type });
      } catch (err) {
        logger.error("promote_row_error", { id: row.id, error: String(err) });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, promoted: promotedCount, total: rows.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    logger.error("promote_unhandled_error", { error: String(err) });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
