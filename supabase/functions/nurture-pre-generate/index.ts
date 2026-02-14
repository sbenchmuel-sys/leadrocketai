import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Pre-generates nurture email drafts 24 hours before scheduled send
 * for leads in "review" nurture mode.
 * 
 * Called on a daily cron schedule.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Guard: only allow calls authenticated with the service role key
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (token !== serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date();
    // Look for leads whose next nurture is due within 24-48 hours
    const windowStart = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    // Find nurture leads in review mode with upcoming eligible_at
    const { data: nurtureLeads, error: queryErr } = await supabase
      .from("leads")
      .select("id, name, email, company, motion, stage, nurture_mode, nurture_cadence, nurture_theme, nurture_outbound_count, next_action_key, owner_user_id, eligible_at")
      .eq("motion", "nurture")
      .eq("nurture_mode", "review")
      .eq("nurture_status", "active")
      .eq("needs_action", true)
      .not("eligible_at", "is", null)
      .gte("eligible_at", windowStart.toISOString())
      .lte("eligible_at", windowEnd.toISOString())
      .eq("status", "active")
      .limit(20);

    if (queryErr) {
      console.error("[nurture-pre-generate] Query error:", queryErr);
      return new Response(JSON.stringify({ ok: false, error: queryErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!nurtureLeads || nurtureLeads.length === 0) {
      return new Response(JSON.stringify({ ok: true, generated: 0, message: "No nurture leads in review window" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[nurture-pre-generate] Found ${nurtureLeads.length} leads needing pre-generated drafts`);

    let generated = 0;
    const errors: string[] = [];

    for (const lead of nurtureLeads) {
      try {
        // Check if a draft already exists for this step
        const stepKey = lead.next_action_key || `send_nurture_${(lead.nurture_outbound_count || 0) + 1}`;
        const { data: existingDraft } = await supabase
          .from("drafts")
          .select("id")
          .eq("lead_id", lead.id)
          .eq("step_key", stepKey)
          .eq("status", "pending")
          .limit(1)
          .maybeSingle();

        if (existingDraft) {
          console.log(`[nurture-pre-generate] Draft already exists for lead ${lead.id} step ${stepKey}`);
          continue;
        }

        // Generate draft via ai_task
        const aiResponse = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            task: "nurture_email_single",
            payload: {
              lead_id: lead.id,
              lead_context: `Name: ${lead.name}\nCompany: ${lead.company}\nEmail: ${lead.email}\nMotion: nurture\nStage: ${lead.stage}`,
              theme: lead.nurture_theme || "balanced",
              email_number: (lead.nurture_outbound_count || 0) + 1,
            },
          }),
        });

        if (!aiResponse.ok) {
          console.error(`[nurture-pre-generate] AI failed for lead ${lead.id}`);
          errors.push(`Lead ${lead.id}: AI generation failed`);
          continue;
        }

        const aiResult = await aiResponse.json();
        if (!aiResult.ok || !aiResult.content) {
          console.error(`[nurture-pre-generate] No content for lead ${lead.id}`);
          errors.push(`Lead ${lead.id}: No content generated`);
          continue;
        }

        // Save as pending draft for review
        const { error: insertErr } = await supabase.from("drafts").insert({
          lead_id: lead.id,
          channel: "email",
          draft_type: "nurture_email_single",
          subject: `Thought you'd find this valuable, ${lead.name.split(" ")[0]}`,
          body_text: aiResult.content,
          status: "pending",
          step_key: stepKey,
          nurture_theme: lead.nurture_theme,
          nurture_cadence: lead.nurture_cadence,
          created_by: lead.owner_user_id,
        });

        if (insertErr) {
          console.error(`[nurture-pre-generate] Insert failed for lead ${lead.id}:`, insertErr);
          errors.push(`Lead ${lead.id}: Draft save failed`);
          continue;
        }

        console.log(`[nurture-pre-generate] Draft pre-generated for lead ${lead.id}, step ${stepKey}`);
        generated++;
      } catch (err) {
        console.error(`[nurture-pre-generate] Error for lead ${lead.id}:`, err);
        errors.push(`Lead ${lead.id}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      generated,
      errors: errors.length > 0 ? errors : undefined,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[nurture-pre-generate] Fatal error:", err);
    return new Response(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
