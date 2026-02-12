import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date().toISOString();

    // Step 1: Find leads eligible for automation
    const { data: eligibleLeads, error: queryErr } = await supabase
      .from("leads")
      .select("id, name, email, company, motion, stage, next_action_key, next_action_label, owner_user_id, last_inbound_at, has_future_meeting, nurture_mode, nurture_cadence, nurture_theme, nurture_outbound_count, eligible_at")
      .eq("needs_action", true)
      .not("eligible_at", "is", null)
      .lte("eligible_at", now)
      .in("status", ["active", "new"])
      .limit(20);

    if (queryErr) {
      console.error("[automation-executor] Query error:", queryErr);
      return new Response(JSON.stringify({ ok: false, error: queryErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!eligibleLeads || eligibleLeads.length === 0) {
      return new Response(JSON.stringify({ ok: true, processed: 0, message: "No eligible leads" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[automation-executor] Found ${eligibleLeads.length} eligible leads`);

    let processed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const lead of eligibleLeads) {
      try {
        // SAFETY RE-CHECK: Fetch fresh lead state before acting
        const { data: freshLead, error: freshErr } = await supabase
          .from("leads")
          .select("last_inbound_at, has_future_meeting, motion, stage, needs_action, eligible_at, status")
          .eq("id", lead.id)
          .single();

        if (freshErr || !freshLead) {
          console.warn(`[automation-executor] Could not re-fetch lead ${lead.id}, skipping`);
          skipped++;
          continue;
        }

        // Safety checks
        const hasReply = !!freshLead.last_inbound_at;
        const hasMeeting = freshLead.has_future_meeting;
        const isClosed = freshLead.stage === "closed_won" || freshLead.stage === "closed_lost";
        const motionChanged = freshLead.motion !== "outbound_prospecting" && freshLead.motion !== "inbound_response" && freshLead.motion !== "nurture";
        const statusInactive = freshLead.status !== "active";
        const noLongerNeeded = !freshLead.needs_action || !freshLead.eligible_at;

        // Stop-on-reply for non-nurture leads
        if (freshLead.motion !== "nurture" && hasReply) {
          console.log(`[automation-executor] Lead ${lead.id} has reply, pausing automation`);
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
            action_reason_code: null,
          }).eq("id", lead.id);
          skipped++;
          continue;
        }

        if (hasMeeting || isClosed || motionChanged || statusInactive || noLongerNeeded) {
          console.log(`[automation-executor] Lead ${lead.id} safety block:`, {
            hasMeeting, isClosed, motionChanged, statusInactive, noLongerNeeded,
          });
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
          }).eq("id", lead.id);
          skipped++;
          continue;
        }

        // Get the user's Gmail connection
        const { data: gmailConn } = await supabase
          .from("gmail_connections")
          .select("user_id")
          .eq("user_id", lead.owner_user_id)
          .single();

        if (!gmailConn) {
          console.warn(`[automation-executor] Lead ${lead.id}: owner has no Gmail connection, skipping`);
          skipped++;
          continue;
        }

        // Get user's auth session token via service role impersonation
        // We call ai_task and gmail-send with the service role key instead
        const actionKey = lead.next_action_key || "send_pre_2_followup";

        // Determine AI task type
        let aiTask = "pre_email_2_followup";
        if (actionKey.startsWith("send_pre_1")) aiTask = "pre_email_1_intro";
        else if (actionKey.startsWith("send_pre_2")) aiTask = "pre_email_2_followup";
        else if (actionKey.startsWith("send_pre_3")) aiTask = "pre_email_3_followup";
        else if (actionKey.startsWith("send_pre_4")) aiTask = "pre_email_4_breakup";
        else if (actionKey.startsWith("send_nurture")) aiTask = "nurture_email_single";

        // Fetch rep profile and signature for personalization
        const { data: repProfile } = await supabase
          .from("rep_profiles")
          .select("full_name, company_name, job_title, calendar_link, phone, email, linkedin_url")
          .eq("user_id", lead.owner_user_id)
          .single();

        const { data: repSignature } = await supabase
          .from("rep_signatures")
          .select("signature_text")
          .eq("user_id", lead.owner_user_id)
          .eq("is_default", true)
          .single();

        // Generate draft via ai_task
        const aiResponse = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            task: aiTask,
            payload: {
              lead_id: lead.id,
              lead_context: `Name: ${lead.name}\nCompany: ${lead.company}\nEmail: ${lead.email}\nMotion: ${lead.motion}\nStage: ${lead.stage}`,
              rep_context: repProfile ? `Sender Name: ${repProfile.full_name || "Sales Rep"}\nSender Title: ${repProfile.job_title || ""}\nSender Company: ${repProfile.company_name || ""}\nCalendar Link: ${repProfile.calendar_link || ""}` : "",
              custom_instructions: null,
            },
          }),
        });

        if (!aiResponse.ok) {
          const errText = await aiResponse.text();
          console.error(`[automation-executor] AI task failed for lead ${lead.id}:`, errText);
          errors.push(`Lead ${lead.id}: AI failed`);
          continue;
        }

        const aiResult = await aiResponse.json();
        if (!aiResult.ok || !aiResult.content) {
          console.error(`[automation-executor] AI returned no content for lead ${lead.id}`);
          errors.push(`Lead ${lead.id}: No AI content`);
          continue;
        }

        // Resolve placeholders in AI content
        const repFirstName = repProfile?.full_name?.split(" ")[0] || "";
        let draftBody = aiResult.content
          .replace(/\{Rep'?s?\s*first\s*name\}/gi, repFirstName)
          .replace(/\[Rep'?s?\s*first\s*name\]/gi, repFirstName)
          .replace(/\{Your\s*Name\}/gi, repFirstName)
          .replace(/\[Your\s*Name\]/gi, repFirstName)
          .replace(/\{Sender\s*Name\}/gi, repFirstName)
          .replace(/\[Sender\s*Name\]/gi, repFirstName)
          .replace(/\{First\s*Name\}/gi, repFirstName)
          .replace(/\[First\s*Name\]/gi, repFirstName);

        // Append signature if available
        if (repSignature?.signature_text) {
          draftBody += `\n\n${repSignature.signature_text}`;
        } else if (repProfile?.full_name) {
          // Fallback: simple name signature
          const sigParts = [repProfile.full_name];
          if (repProfile.job_title) sigParts.push(repProfile.job_title);
          if (repProfile.company_name) sigParts.push(repProfile.company_name);
          if (repProfile.phone) sigParts.push(repProfile.phone);
          if (repProfile.email) sigParts.push(repProfile.email);
          draftBody += `\n\n${sigParts.join("\n")}`;
        }

        // Append unsubscribe footer
        draftBody += `\n\n---\nIf you'd prefer not to receive these emails, simply reply with "unsubscribe" and we'll remove you from our list.`;

        // Derive proper subject line (not the action label)
        const leadFirstName = lead.name.split(" ")[0];
        const companyName = lead.company !== "Unknown Company" ? lead.company : null;
        let subject: string;
        if (aiTask === "pre_email_1_intro") {
          subject = companyName ? `Introduction - ${companyName}` : `Connecting with you, ${leadFirstName}`;
        } else if (aiTask === "pre_email_2_followup") {
          subject = `Following up - ${leadFirstName}`;
        } else if (aiTask === "pre_email_3_followup") {
          subject = `Checking in - ${leadFirstName}`;
        } else if (aiTask === "pre_email_4_breakup") {
          subject = `Closing the loop - ${leadFirstName}`;
        } else if (aiTask === "nurture_email_single") {
          subject = companyName ? `Thought you'd find this valuable, ${leadFirstName}` : `Thought you'd find this valuable`;
        } else {
          subject = `Following up - ${leadFirstName}`;
        }

        // Save as draft first (for audit trail)
        await supabase.from("drafts").insert({
          lead_id: lead.id,
          channel: "email",
          draft_type: aiTask,
          subject,
          body_text: draftBody,
          status: "auto_sent",
          step_key: lead.next_action_key,
          created_by: lead.owner_user_id,
        });

        // Send via gmail-send
        const sendResponse = await fetch(`${supabaseUrl}/functions/v1/gmail-send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            to: lead.email,
            subject,
            body: draftBody,
            leadId: lead.id,
            ownerUserId: lead.owner_user_id,
          }),
        });

        if (!sendResponse.ok) {
          const sendErr = await sendResponse.text();
          console.error(`[automation-executor] Send failed for lead ${lead.id}:`, sendErr);
          errors.push(`Lead ${lead.id}: Send failed`);
          // Mark draft as failed
          continue;
        }

        const sendResult = await sendResponse.json();
        if (sendResult.needsReconnect) {
          console.warn(`[automation-executor] Gmail needs reconnect for user ${lead.owner_user_id}`);
          // Pause automation for this lead
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
          }).eq("id", lead.id);
          skipped++;
          continue;
        }

        console.log(`[automation-executor] Email sent for lead ${lead.id}: ${sendResult.messageId}`);

        // Log interaction
        await supabase.from("interactions").insert({
          lead_id: lead.id,
          type: "system_note",
          source: "automation",
          body_text: `Auto-sent: ${subject} (${aiTask})`,
          occurred_at: new Date().toISOString(),
        });

        processed++;
      } catch (leadErr) {
        console.error(`[automation-executor] Error processing lead ${lead.id}:`, leadErr);
        errors.push(`Lead ${lead.id}: ${leadErr instanceof Error ? leadErr.message : "Unknown error"}`);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      processed,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[automation-executor] Fatal error:", err);
    return new Response(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
