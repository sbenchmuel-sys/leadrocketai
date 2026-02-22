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

    // -------------------------------------------------------
    // STEP 0: OOO RETURN DETECTION
    // Find leads where ooo_until has passed and eligible_at
    // has arrived — surface "Back in office" action without
    // sending an email. needs_action is currently false for
    // these leads (set during OOO detection in gmail-sync).
    // -------------------------------------------------------
    let oooQuery = supabase
      .from("leads")
      .select("id, name, company, owner_user_id, ooo_until, eligible_at")
      .not("ooo_until", "is", null)
      .lte("ooo_until", now)          // OOO period has ended
      .not("eligible_at", "is", null)
      .lte("eligible_at", now)        // eligible_at has arrived
      .eq("needs_action", false)      // not yet surfaced
      .eq("unsubscribed", false)
      .in("status", ["active", "new"])
      .limit(20);

    if (ownerFilter) {
      oooQuery = oooQuery.eq("owner_user_id", ownerFilter);
    }

    const { data: oooLeads } = await oooQuery;

    if (oooLeads && oooLeads.length > 0) {
      console.log(`[automation-executor] Found ${oooLeads.length} OOO-returning leads`);
      for (const lead of oooLeads) {
        const leadFirstName = lead.name.split(" ")[0];
        await supabase.from("leads").update({
          needs_action: true,
          next_action_key: "ooo_return_followup",
          next_action_label: `Back in office — follow up with ${leadFirstName}`,
          action_reason_code: "OOO_RETURN",
          ooo_until: null, // clear OOO flag now that we've surfaced it
        }).eq("id", lead.id);

        // Log a system note in the timeline
        await supabase.from("interactions").insert({
          lead_id: lead.id,
          type: "system_note",
          source: "automation",
          body_text: `${lead.name} is back in the office. Follow-up action surfaced.`,
          occurred_at: new Date().toISOString(),
        });

        console.log(`[automation-executor] OOO return surfaced for lead ${lead.id} (${lead.name})`);
      }
    }

    // -------------------------------------------------------
    // STEP 0.5: WHATSAPP 6-HOUR NO-REPLY CHECK (PART 2)
    // If a lead sent an inbound WA message >6h ago and we
    // haven't replied (no outbound in that window), surface
    // needs_action so the rep sees it in the dashboard.
    // Safety: skip leads already flagged, OOO leads, unsubscribed.
    // -------------------------------------------------------
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    let waCheckQuery = supabase
      .from("leads")
      .select("id, name, phone, last_inbound_at, last_outbound_at, needs_action, next_action_key, ooo_until")
      .not("last_inbound_at", "is", null)
      .lte("last_inbound_at", sixHoursAgo)   // inbound was >6h ago
      .eq("needs_action", false)              // not already actioned
      .eq("unsubscribed", false)
      .in("status", ["active", "new"])
      .is("ooo_until", null)                  // not OOO
      .not("phone", "is", null)               // only flag if phone number exists
      .limit(30);

    if (ownerFilter) {
      waCheckQuery = waCheckQuery.eq("owner_user_id", ownerFilter);
    }

    const { data: pendingWaLeads } = await waCheckQuery;

    if (pendingWaLeads && pendingWaLeads.length > 0) {
      for (const lead of pendingWaLeads) {
        // Check if last_outbound_at is AFTER last_inbound_at → already replied
        const lastIn = lead.last_inbound_at ? new Date(lead.last_inbound_at).getTime() : 0;
        const lastOut = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;
        if (lastOut >= lastIn) continue; // rep already replied — skip

        // Flag as needing action: WhatsApp reply pending
        await supabase.from("leads").update({
          needs_action: true,
          next_action_key: "whatsapp_reply",
          next_action_label: "Reply via WhatsApp",
          action_reason_code: "REPLY_PENDING",
        } as any).eq("id", lead.id);

        console.log(`[automation-executor] WA 6h no-reply flagged for lead ${lead.id}`);
      }
    }

    // Find eligible leads (existing automation email flow)
    // CRITICAL: Exclude nurture leads — they are handled separately by the nurture pre-generate pipeline.
    // Nurture leads in "review" mode need manual approval; "automatic" mode is handled by its own flow.
    // Allowing nurture leads here causes prospecting emails to be sent erroneously.
    let query = supabase
      .from("leads")
      .select("id, name, email, company, motion, stage, next_action_key, next_action_label, owner_user_id, last_inbound_at, has_future_meeting, nurture_mode, nurture_cadence, nurture_theme, nurture_outbound_count, eligible_at, unsubscribed")
      .eq("needs_action", true)
      .not("eligible_at", "is", null)
      .lte("eligible_at", now)
      .in("status", ["active", "new"])
      .eq("unsubscribed", false)
      .neq("next_action_key", "ooo_return_followup") // OOO returns are handled above — no email needed
      .neq("motion", "nurture") // SAFETY: nurture leads must never enter the prospecting email pipeline
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

        // ── PART 6: WhatsApp automation safety guard ──────────────
        // WA auto-sends are blocked unless BOTH conditions are true:
        //   1. workspace cadence_settings.whatsapp.automation_enabled = true
        //   2. lead.wa_opted_in = true
        // Default for both is false — manual-send-only by default.
        const isWaActionKey = (lead.next_action_key || "").startsWith("whatsapp_");
        if (isWaActionKey) {
          // Fetch wa_opted_in for this lead
          const { data: waLead } = await supabase
            .from("leads")
            .select("wa_opted_in")
            .eq("id", lead.id)
            .single();

          // Fetch workspace cadence to check automation_enabled
          const { data: wpProfile } = await supabase
            .from("workspace_profiles")
            .select("cadence_settings")
            .eq("user_id", lead.owner_user_id)
            .single();

          const cadence = (wpProfile?.cadence_settings as any) ?? {};
          const waAutomationEnabled = cadence?.whatsapp?.automation_enabled === true;
          const leadOptedIn = (waLead as any)?.wa_opted_in === true;

          if (!waAutomationEnabled || !leadOptedIn) {
            logEntry.status = "skipped";
            logEntry.error_message = waAutomationEnabled
              ? "Lead not opted in to WhatsApp automation"
              : "WhatsApp automation disabled at workspace level";
            logEntry.completed_at = new Date().toISOString();
            await supabase.from("automation_log").insert(logEntry);
            console.log(`[automation-executor] WA auto-send blocked for lead ${lead.id}: wa_automation=${waAutomationEnabled}, opted_in=${leadOptedIn}`);
            skipped++;
            continue;
          }
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
            if (/\bstop\s+emailing\b/.test(bodyLower) || /\bremove\s+me\b/.test(bodyLower) || /\bplease\s+(don['']t|do\s+not|stop)\s+(email|contact|reach)\b/.test(bodyLower)) {
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

        // Get connected mail account (Gmail or Outlook)
        let mailProvider: "gmail" | "outlook" = "gmail";
        let mailAccountId: string | null = null;

        // Check mail_accounts table first (unified multi-mailbox)
        const { data: wsMember } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .eq("user_id", lead.owner_user_id)
          .limit(1)
          .maybeSingle();

        if (wsMember?.workspace_id) {
          const { data: mailAcct } = await supabase
            .from("mail_accounts")
            .select("id, provider, email_address")
            .eq("workspace_id", wsMember.workspace_id)
            .eq("status", "connected")
            .order("is_default", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (mailAcct) {
            mailProvider = mailAcct.provider as "gmail" | "outlook";
            mailAccountId = mailAcct.id;
          }
        }

        // Fall back to legacy gmail_connections if no mail_account found
        if (!mailAccountId) {
          const { data: gmailConn } = await supabase
            .from("gmail_connections")
            .select("user_id")
            .eq("user_id", lead.owner_user_id)
            .maybeSingle();

          if (!gmailConn) {
            logEntry.status = "skipped";
            logEntry.error_message = "No mail connection (Gmail or Outlook)";
            logEntry.completed_at = new Date().toISOString();
            await supabase.from("automation_log").insert(logEntry);
            skipped++;
            continue;
          }
          mailProvider = "gmail";
        }

        logEntry.mail_account_id = mailAccountId;

        const actionKey = lead.next_action_key;

        // Determine AI task type — motion-aware resolution
        // SAFETY: nurture leads are blocked by the query filter above, but double-check here
        // to ensure we never send a prospecting email to a nurture lead via any code path.
        if (lead.motion === "nurture") {
          console.warn(`[automation-executor] BLOCKED: nurture lead ${lead.id} reached email send path — skipping`);
          logEntry.status = "skipped";
          logEntry.error_message = "Nurture lead blocked from prospecting email pipeline";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        let aiTask: string;
        if (actionKey) {
          if (actionKey.startsWith("send_pre_1")) aiTask = "pre_email_1_intro";
          else if (actionKey.startsWith("send_pre_2")) aiTask = "pre_email_2_followup";
          else if (actionKey.startsWith("send_pre_3")) aiTask = "pre_email_3_followup";
          else if (actionKey.startsWith("send_pre_4")) aiTask = "pre_email_4_breakup";
          else if (actionKey.startsWith("send_nurture") || actionKey.startsWith("nurture_")) aiTask = "nurture_email_single";
          else aiTask = "pre_email_2_followup"; // truly unknown key — prospecting fallback (non-nurture only)
        } else {
          aiTask = "pre_email_1_intro"; // first outbound if no key (non-nurture leads only at this point)
        }

        logEntry.ai_task = aiTask;

        // GUARD 1: Daily per-lead cap — enforced atomically at DB level via unique index.
        // We no longer do a pre-flight SELECT count (racy under concurrent runs).
        // Instead, we attempt the INSERT after send and let the DB reject the duplicate.
        // See: automation_log_one_per_day_unique index (WHERE status = 'sent').
        // Pre-flight check for TODAY is still done as a fast-path skip to avoid
        // wasting an AI call + send on a lead that already got an email today.
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const { count: todaySentCount } = await supabase
          .from("automation_log")
          .select("id", { count: "exact", head: true })
          .eq("lead_id", lead.id)
          .eq("status", "sent")
          .gte("created_at", todayStart.toISOString());

        if ((todaySentCount || 0) >= 1) {
          console.log(`[automation-executor] Lead ${lead.id}: Pre-flight daily cap hit (${todaySentCount} sent today) — pushing to tomorrow`);
          logEntry.status = "skipped";
          logEntry.error_message = "Daily send limit reached (1 per lead per day)";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(9, 30, 0, 0);
          await supabase.from("leads").update({ eligible_at: tomorrow.toISOString() }).eq("id", lead.id);
          skipped++;
          continue;
        }

        // GUARD 2: Action-level dedup — this specific action was already sent successfully
        // Prevents re-sending the same step (e.g. send_nurture_1) if eligible_at was reset by a bug
        const { count: actionSentCount } = await supabase
          .from("automation_log")
          .select("id", { count: "exact", head: true })
          .eq("lead_id", lead.id)
          .eq("action_key", actionKey)
          .eq("status", "sent");

        if ((actionSentCount || 0) >= 1) {
          console.log(`[automation-executor] Lead ${lead.id}: Action ${actionKey} already sent — clearing and skipping duplicate`);
          logEntry.status = "skipped";
          logEntry.error_message = "Action already sent — skipping duplicate";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          await supabase.from("leads").update({ needs_action: false, eligible_at: null }).eq("id", lead.id);
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
                motion: lead.motion,
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

        // Send via appropriate mail provider
        let sendResponse: Response;
        if (mailProvider === "outlook" && mailAccountId) {
          const bodyHtml = draftBody.replace(/\n/g, "<br>");
          sendResponse = await fetch(`${supabaseUrl}/functions/v1/outlook-send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              mail_account_id: mailAccountId,
              to: lead.email,
              subject,
              bodyHtml,
              leadId: lead.id,
              ownerUserId: lead.owner_user_id,
              skipStateUpdate: true,
            }),
          });
        } else {
          sendResponse = await fetch(`${supabaseUrl}/functions/v1/gmail-send`, {
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
              skipStateUpdate: true,
            }),
          });
        }

        // gmail-send always returns HTTP 200 (even on error) so the JSON body is readable.
        // We must check sendResult.ok (the JSON field) — NOT sendResponse.ok (the HTTP status).
        const sendResult = await sendResponse.json();

        if (!sendResult.ok) {
          const sendErr = sendResult.error || "Unknown send error";
          console.error(`[automation-executor] Send failed for lead ${lead.id}:`, sendErr);

          if (sendResult.needsReconnect) {
            console.warn(`[automation-executor] ${mailProvider} needs reconnect for user ${lead.owner_user_id}`);
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

          logEntry.status = "failed";
          logEntry.error_message = `${mailProvider} send failed: ${String(sendErr).substring(0, 200)}`;
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          // Retry: push eligible_at forward 15 min
          await supabase.from("leads").update({
            eligible_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          }).eq("id", lead.id);
          errors.push(`Lead ${lead.id}: Send failed`);
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

        // ATOMIC LOG INSERT: The unique index (automation_log_one_per_day_unique) enforces
        // at most one 'sent' record per (lead_id, action_key, day). If a concurrent executor
        // run already committed a 'sent' record for this lead+action today, this upsert is
        // silently ignored — blocking the duplicate at the DB level.
        logEntry.status = "sent";
        logEntry.gmail_message_id = gmailMessageId;
        logEntry.completed_at = new Date().toISOString();
        const { error: logInsertError } = await (supabase.from("automation_log") as any)
          .upsert(logEntry, { onConflict: "lead_id,action_key,date_trunc('day', created_at AT TIME ZONE 'UTC')", ignoreDuplicates: true });

        if (logInsertError) {
          // Conflict means a concurrent run already sent this email today — skip post-send state update
          console.warn(`[automation-executor] Duplicate blocked by DB for lead ${lead.id}, action ${actionKey}: ${logInsertError.message}`);
          skipped++;
          continue;
        }

        // --- POST-SEND STATE UPDATE ---
        const postUpdate: Record<string, unknown> = {
          needs_action: false,
          eligible_at: null,
          last_outbound_at: new Date().toISOString(),
          last_activity_at: new Date().toISOString(),
        };

        if (aiTask === "nurture_email_single") {
          // Nurture: increment count and schedule next based on cadence
          const cadenceDays = lead.nurture_cadence === "weekly" ? 7
            : lead.nurture_cadence === "monthly" ? 30 : 14;
          const nextEligible = new Date(Date.now() + cadenceDays * 86400000);
          nextEligible.setHours(9, 30, 0, 0);
          const nextCount = (lead.nurture_outbound_count || 0) + 1;

          Object.assign(postUpdate, {
            nurture_outbound_count: nextCount,
            last_nurture_outbound_at: new Date().toISOString(),
            next_action_key: `send_nurture_${nextCount + 1}`,
            next_action_label: `Nurture email #${nextCount + 1}`,
            needs_action: true,
            eligible_at: nextEligible.toISOString(),
            action_reason_code: "NURTURE_DUE",
          });
        } else if (["pre_email_1_intro", "pre_email_2_followup", "pre_email_3_followup"].includes(aiTask)) {
          // Outbound sequence: schedule next step
          const NEXT_STEP: Record<string, { key: string; label: string }> = {
            pre_email_1_intro: { key: "send_pre_2", label: "Follow-up 1" },
            pre_email_2_followup: { key: "send_pre_3", label: "Follow-up 2" },
            pre_email_3_followup: { key: "send_pre_4", label: "Breakup Email" },
          };
          const nextStep = NEXT_STEP[aiTask];
          if (nextStep) {
            const nextEligible = new Date(Date.now() + 2 * 86400000);
            nextEligible.setHours(9, 30, 0, 0);
            Object.assign(postUpdate, {
              next_action_key: nextStep.key,
              next_action_label: nextStep.label,
              needs_action: true,
              eligible_at: nextEligible.toISOString(),
              action_reason_code: "FOLLOWUP_DUE",
            });
          }
        }
        // pre_email_4_breakup: no next step, stays needs_action=false

        await supabase.from("leads").update(postUpdate).eq("id", lead.id);
        console.log(`[automation-executor] Post-send state updated for lead ${lead.id}:`, JSON.stringify(postUpdate));

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
