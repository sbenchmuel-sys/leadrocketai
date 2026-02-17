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

    // Allow both service-role and user-auth calls
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    const isServiceRole = token === supabaseServiceKey;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let ownerFilter: string | null = null;

    if (!isServiceRole) {
      // User-auth: resolve user and scope to their leads
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: authErr } = await userClient.auth.getUser();
      if (authErr || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      ownerFilter = user.id;
    }

    const now = new Date().toISOString();

    // Find eligible leads
    let query = supabase
      .from("leads")
      .select("id, name, email, company, motion, stage, next_action_key, next_action_label, owner_user_id, last_inbound_at, has_future_meeting, nurture_mode, nurture_cadence, nurture_theme, nurture_outbound_count, eligible_at, unsubscribed")
      .eq("needs_action", true)
      .not("eligible_at", "is", null)
      .lte("eligible_at", now)
      .in("status", ["active", "new"])
      .eq("unsubscribed", false)
      .limit(20);

    if (ownerFilter) {
      query = query.eq("owner_user_id", ownerFilter);
    }

    const { data: eligibleLeads, error: queryErr } = await query;

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

    // --- STRATEGY 6: Rep Profile/Signature Preloading ---
    // Fetch once before the loop and reuse for all leads (same owner in batch)
    const firstOwnerId = eligibleLeads[0]?.owner_user_id;
    const { data: repProfileCache } = await supabase
      .from("rep_profiles")
      .select("full_name, company_name, job_title, calendar_link, phone, email, linkedin_url")
      .eq("user_id", firstOwnerId)
      .single();

    const { data: repSignatureCache } = await supabase
      .from("rep_signatures")
      .select("signature_text")
      .eq("user_id", firstOwnerId)
      .eq("is_default", true)
      .single();

    let processed = 0;
    let skipped = 0;
    const errors: string[] = [];
    const sentLeads: { leadId: string; leadName: string; subject: string }[] = [];

    for (const lead of eligibleLeads) {
      const logEntry: Record<string, unknown> = {
        lead_id: lead.id,
        owner_user_id: lead.owner_user_id,
        action_key: lead.next_action_key,
        status: "pending",
        created_at: new Date().toISOString(),
      };

      try {
        // SAFETY RE-CHECK
        const { data: freshLead, error: freshErr } = await supabase
          .from("leads")
          .select("last_inbound_at, has_future_meeting, motion, stage, needs_action, eligible_at, status, unsubscribed")
          .eq("id", lead.id)
          .single();

        if (freshErr || !freshLead) {
          logEntry.status = "skipped";
          logEntry.error_message = "Could not re-fetch lead";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // Unsubscribed check
        if (freshLead.unsubscribed) {
          logEntry.status = "skipped";
          logEntry.error_message = "Lead unsubscribed";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
            action_reason_code: null,
          }).eq("id", lead.id);
          skipped++;
          continue;
        }

        // Check for unsubscribe keyword in last inbound
        if (freshLead.last_inbound_at) {
          const { data: lastInbound } = await supabase
            .from("interactions")
            .select("body_text")
            .eq("lead_id", lead.id)
            .eq("direction", "inbound")
            .order("occurred_at", { ascending: false })
            .limit(1)
            .single();

          if (lastInbound?.body_text) {
            const bodyLower = lastInbound.body_text.toLowerCase();
            if (/\bunsubscribe\b/.test(bodyLower) || /\bstop\s+emailing\b/.test(bodyLower) || /\bremove\s+me\b/.test(bodyLower)) {
              console.log(`[automation-executor] Lead ${lead.id} requested unsubscribe`);
              await supabase.from("leads").update({
                unsubscribed: true,
                needs_action: false,
                eligible_at: null,
                next_action_key: null,
                next_action_label: null,
                action_reason_code: null,
                nurture_status: "inactive",
              }).eq("id", lead.id);

              await supabase.from("interactions").insert({
                lead_id: lead.id,
                type: "system_note",
                source: "automation",
                body_text: "Lead requested to unsubscribe — automation stopped permanently.",
                occurred_at: new Date().toISOString(),
              });

              logEntry.status = "skipped";
              logEntry.error_message = "Unsubscribe detected in last inbound";
              logEntry.completed_at = new Date().toISOString();
              await supabase.from("automation_log").insert(logEntry);
              skipped++;
              continue;
            }
          }
        }

        // Safety checks
        const hasReply = !!freshLead.last_inbound_at;
        const hasMeeting = freshLead.has_future_meeting;
        const isClosed = freshLead.stage === "closed_won" || freshLead.stage === "closed_lost";
        const motionChanged = freshLead.motion !== "outbound_prospecting" && freshLead.motion !== "inbound_response" && freshLead.motion !== "nurture";
        const statusInactive = freshLead.status !== "active" && freshLead.status !== "new";
        const noLongerNeeded = !freshLead.needs_action || !freshLead.eligible_at;

        // Stop-on-reply for non-nurture leads
        if (freshLead.motion !== "nurture" && hasReply) {
          console.log(`[automation-executor] Lead ${lead.id} has reply, pausing automation`);
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
            action_reason_code: null,
          }).eq("id", lead.id);
          logEntry.status = "skipped";
          logEntry.error_message = "Lead replied — safety pause";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
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
          logEntry.status = "skipped";
          logEntry.error_message = `Safety block: ${hasMeeting ? "meeting" : isClosed ? "closed" : motionChanged ? "motion" : statusInactive ? "inactive" : "not needed"}`;
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // Get Gmail connection
        const { data: gmailConn } = await supabase
          .from("gmail_connections")
          .select("user_id")
          .eq("user_id", lead.owner_user_id)
          .single();

        if (!gmailConn) {
          logEntry.status = "skipped";
          logEntry.error_message = "No Gmail connection";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        const actionKey = lead.next_action_key || "send_pre_2_followup";

        // Determine AI task type
        let aiTask = "pre_email_2_followup";
        if (actionKey.startsWith("send_pre_1")) aiTask = "pre_email_1_intro";
        else if (actionKey.startsWith("send_pre_2")) aiTask = "pre_email_2_followup";
        else if (actionKey.startsWith("send_pre_3")) aiTask = "pre_email_3_followup";
        else if (actionKey.startsWith("send_pre_4")) aiTask = "pre_email_4_breakup";
        else if (actionKey.startsWith("send_nurture")) aiTask = "nurture_email_single";

        logEntry.ai_task = aiTask;

        // Retry check: max 2 retries per lead+action
        const { count: retryCount } = await supabase
          .from("automation_log")
          .select("id", { count: "exact", head: true })
          .eq("lead_id", lead.id)
          .eq("action_key", actionKey)
          .eq("status", "failed");

        if ((retryCount || 0) >= 2) {
          logEntry.status = "skipped";
          logEntry.error_message = "Max retries (2) exceeded for this action";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
          }).eq("id", lead.id);
          skipped++;
          continue;
        }

        // --- STRATEGY 1: Draft Caching ---
        // Check for an existing pending draft for this lead+step before calling AI
        const { data: cachedDraft } = await supabase
          .from("drafts")
          .select("body_text, subject")
          .eq("lead_id", lead.id)
          .eq("step_key", actionKey)
          .eq("status", "pending")
          .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        let draftBody: string;
        let subject: string;
        const repProfile = repProfileCache;
        const repSignature = repSignatureCache;

        if (cachedDraft?.body_text) {
          console.log(`[automation-executor] ♻️ Reusing cached draft for lead ${lead.id}, step ${actionKey}`);
          draftBody = cachedDraft.body_text;
          subject = cachedDraft.subject || `Following up - ${lead.name.split(" ")[0]}`;
        } else {
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
            logEntry.status = "failed";
            logEntry.error_message = `AI generation failed: ${errText.substring(0, 200)}`;
            logEntry.completed_at = new Date().toISOString();
            await supabase.from("automation_log").insert(logEntry);
            await supabase.from("leads").update({
              eligible_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            }).eq("id", lead.id);
            errors.push(`Lead ${lead.id}: AI failed`);
            continue;
          }

          const aiResult = await aiResponse.json();
          if (!aiResult.ok || !aiResult.content) {
            logEntry.status = "failed";
            logEntry.error_message = "AI returned no content";
            logEntry.completed_at = new Date().toISOString();
            await supabase.from("automation_log").insert(logEntry);
            await supabase.from("leads").update({
              eligible_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            }).eq("id", lead.id);
            errors.push(`Lead ${lead.id}: No AI content`);
            continue;
          }

          // Resolve placeholders
          const repFirstName = repProfile?.full_name?.split(" ")[0] || "";
          draftBody = aiResult.content
            .replace(/\{Rep'?s?\s*first\s*name\}/gi, repFirstName)
            .replace(/\[Rep'?s?\s*first\s*name\]/gi, repFirstName)
            .replace(/\{Your\s*Name\}/gi, repFirstName)
            .replace(/\[Your\s*Name\]/gi, repFirstName)
            .replace(/\{Sender\s*Name\}/gi, repFirstName)
            .replace(/\[Sender\s*Name\]/gi, repFirstName)
            .replace(/\{First\s*Name\}/gi, repFirstName)
            .replace(/\[First\s*Name\]/gi, repFirstName);

          // Append signature
          if (repSignature?.signature_text) {
            draftBody += `\n\n${repSignature.signature_text}`;
          } else if (repProfile?.full_name) {
            const sigParts = [repProfile.full_name];
            if (repProfile.job_title) sigParts.push(repProfile.job_title);
            if (repProfile.company_name) sigParts.push(repProfile.company_name);
            if (repProfile.phone) sigParts.push(repProfile.phone);
            if (repProfile.email) sigParts.push(repProfile.email);
            draftBody += `\n\n${sigParts.join("\n")}`;
          }

          // Unsubscribe footer
          draftBody += `\n\n---\nIf you'd prefer not to receive these emails, simply reply with "unsubscribe" and we'll remove you from our list.`;

          // Subject line
          const leadFirstName = lead.name.split(" ")[0];
          const companyName = lead.company !== "Unknown Company" ? lead.company : null;
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
        } // end else (no cached draft)

        logEntry.subject = subject;

        // Save as draft for audit trail
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
          logEntry.status = "failed";
          logEntry.error_message = `Gmail send failed: ${sendErr.substring(0, 200)}`;
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          // Retry: push eligible_at forward 15 min
          await supabase.from("leads").update({
            eligible_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          }).eq("id", lead.id);
          errors.push(`Lead ${lead.id}: Send failed`);
          continue;
        }

        const sendResult = await sendResponse.json();
        if (sendResult.needsReconnect) {
          console.warn(`[automation-executor] Gmail needs reconnect for user ${lead.owner_user_id}`);
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
          }).eq("id", lead.id);
          logEntry.status = "failed";
          logEntry.error_message = "Gmail needs reconnection";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        const gmailMessageId = sendResult.messageId || null;
        console.log(`[automation-executor] Email sent for lead ${lead.id}: ${gmailMessageId}`);

        // Log as email_outbound (not system_note) so it appears in timeline/inbox
        await supabase.from("interactions").insert({
          lead_id: lead.id,
          type: "email_outbound",
          source: "automation",
          body_text: draftBody,
          subject,
          direction: "outbound",
          from_email: repProfile?.email || null,
          to_email: lead.email,
          gmail_message_id: gmailMessageId,
          occurred_at: new Date().toISOString(),
        });

        // Log success
        logEntry.status = "sent";
        logEntry.gmail_message_id = gmailMessageId;
        logEntry.completed_at = new Date().toISOString();
        await supabase.from("automation_log").insert(logEntry);

        sentLeads.push({ leadId: lead.id, leadName: lead.name, subject });
        processed++;
      } catch (leadErr) {
        console.error(`[automation-executor] Error processing lead ${lead.id}:`, leadErr);
        logEntry.status = "failed";
        logEntry.error_message = leadErr instanceof Error ? leadErr.message : "Unknown error";
        logEntry.completed_at = new Date().toISOString();
        await supabase.from("automation_log").insert(logEntry);
        // Retry: push eligible_at forward 15 min
        await supabase.from("leads").update({
          eligible_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }).eq("id", lead.id);
        errors.push(`Lead ${lead.id}: ${leadErr instanceof Error ? leadErr.message : "Unknown error"}`);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      processed,
      skipped,
      sentLeads,
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
