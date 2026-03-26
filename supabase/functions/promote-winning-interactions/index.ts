import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Promotes un-promoted winning_interactions into kb_chunks.
 * Intended to run on a schedule (e.g. every 6 hours).
 *
 * AUTH: Requires X-Internal-Secret or service-role token.
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

  // ── Auth gate ──────────────────────────────────────────────
  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

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

    let promoted = 0;
    const errors: string[] = [];

    for (const row of rows) {
      try {
        // Summarize with AI
        const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
        if (!lovableApiKey) {
          errors.push(`Row ${row.id}: LOVABLE_API_KEY not configured`);
          continue;
        }

        const prompt = `Summarize the following sales message into a concise, reusable messaging pattern. Focus on the approach, tone, and key phrases that made it effective. Keep it under 200 words.\n\nChannel: ${row.channel}\nOutcome: ${row.outcome_type}\n\nMessage:\n${row.message_content}`;

        const aiResp = await fetch("https://ai.lovable.dev/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${lovableApiKey}`,
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            prompt,
            max_tokens: 400,
          }),
        });

        if (!aiResp.ok) {
          errors.push(`Row ${row.id}: AI summarization failed (${aiResp.status})`);
          continue;
        }

        const aiData = await aiResp.json();
        const summary = aiData?.content ?? aiData?.text ?? "";

        if (!summary) {
          errors.push(`Row ${row.id}: No summary returned`);
          continue;
        }

        // Find owner_user_id via workspace members (first admin)
        const { data: member } = await admin
          .from("workspace_members")
          .select("user_id")
          .eq("workspace_id", row.workspace_id)
          .eq("role", "admin")
          .limit(1)
          .maybeSingle();

        // Insert as kb_chunk
        const { error: insertErr } = await admin.from("kb_chunks").insert({
          content: summary,
          title: `Winning ${row.channel} pattern — ${row.outcome_type}`,
          content_type: "messaging",
          source: "winning_interaction",
          priority: 5,
          allowed_customer_facing: true,
          owner_user_id: member?.user_id ?? null,
          lead_id: row.lead_id,
          processing_status: "completed",
        });

        if (insertErr) {
          errors.push(`Row ${row.id}: KB insert failed — ${insertErr.message}`);
          continue;
        }

        // Mark as promoted
        await admin
          .from("winning_interactions")
          .update({ promoted_to_kb: true })
          .eq("id", row.id);

        promoted++;
        logger.info("winning_interaction_promoted", { id: row.id, channel: row.channel });
      } catch (err) {
        errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, promoted, total: rows.length, errors: errors.length ? errors : undefined }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    logger.error("promote_fatal", { error: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
