// ============================================================
// sms-send — Send SMS via Twilio Messages API
// Creates interaction + timeline entry for lead tracking.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isInternalCaller, assertLeadAccess } from "../_shared/authz.ts";
import { projectTimelineItem } from "../_shared/timelineProjector.ts";
import { postSendDeriveAction } from "../_shared/postSendDeriveAction.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // ── Auth ──────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const internal = isInternalCaller(req);

  let userId: string | null = null;
  if (!internal) {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    userId = user.id;
  }

  // ── Parse body ────────────────────────────────────
  let body: {
    to: string;
    body: string;
    leadId?: string;
    ownerUserId?: string;
    skipStateUpdate?: boolean;
    fromNumber?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { to, body: messageBody, leadId, ownerUserId, skipStateUpdate, fromNumber } = body;
  if (!to || !messageBody) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing required fields: to, body" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Lead access check (non-internal) ──────────────
  if (!internal && leadId && userId) {
    const access = await assertLeadAccess(supabase, leadId, userId);
    if (!access.ok) {
      return new Response(JSON.stringify({ ok: false, error: access.error }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // ── Resolve from number ───────────────────────────
  let senderNumber = fromNumber;
  if (!senderNumber && leadId) {
    // Get workspace default SMS number
    const { data: lead } = await supabase
      .from("leads")
      .select("workspace_id")
      .eq("id", leadId)
      .single();
    if (lead?.workspace_id) {
      const { data: ws } = await supabase
        .from("workspaces")
        .select("default_sms_number")
        .eq("id", lead.workspace_id)
        .single();
      senderNumber = ws?.default_sms_number;
    }
  }

  if (!senderNumber) {
    // Fallback to call settings default Twilio number
    if (leadId) {
      const { data: lead } = await supabase
        .from("leads")
        .select("workspace_id")
        .eq("id", leadId)
        .single();
      if (lead?.workspace_id) {
        const { data: cs } = await supabase
          .from("call_settings")
          .select("default_twilio_number")
          .eq("workspace_id", lead.workspace_id)
          .single();
        senderNumber = cs?.default_twilio_number;
      }
    }
  }

  if (!senderNumber) {
    return new Response(
      JSON.stringify({ ok: false, error: "No SMS sender number configured. Set a default SMS number in workspace settings." }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Send via Twilio ───────────────────────────────
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!accountSid || !authToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "Twilio credentials not configured" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const twilioAuth = btoa(`${accountSid}:${authToken}`);

  // Twilio will POST delivery-status events back to this URL.
  // Must be the public Supabase Functions URL (Twilio signs against it).
  const statusCallbackUrl = `${supabaseUrl}/functions/v1/sms-status-webhook`;

  const twilioParams: Record<string, string> = {
    To: to,
    From: senderNumber,
    Body: messageBody,
    StatusCallback: statusCallbackUrl,
  };

  let twilioResponse: Response;
  try {
    twilioResponse = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${twilioAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(twilioParams),
    });
  } catch (fetchErr) {
    console.error("[sms-send] Twilio fetch error:", fetchErr);
    return new Response(
      JSON.stringify({ ok: false, error: `Twilio network error: ${String(fetchErr)}` }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const twilioResult = await twilioResponse.json();
  if (!twilioResponse.ok) {
    console.error("[sms-send] Twilio API error:", JSON.stringify(twilioResult));
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Twilio error: ${twilioResult.message || twilioResult.code || "Unknown"}`,
        needsReconnect: false,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const messageSid = twilioResult.sid;
  console.log(`[sms-send] SMS sent successfully: ${messageSid} to ${to}`);

  // ── Post-send: interaction + timeline ─────────────
  const backgroundTasks = async () => {
    try {
      if (!leadId) return;

      const interactionOccurredAt = new Date().toISOString();
      const dedupeKey = `sms:outbound:${messageSid}`;

      const { data: interactionRow } = await supabase
        .from("interactions")
        .insert({
          lead_id: leadId,
          type: "sms_outbound",
          source: "sms",
          direction: "outbound",
          occurred_at: interactionOccurredAt,
          body_text: messageBody,
          from_email: senderNumber,  // reusing field for sender
          to_email: to,              // reusing field for recipient
          dedupe_key: dedupeKey,
        })
        .select("id")
        .single();

      // Project to unified timeline
      const { data: leadWs } = await supabase
        .from("leads")
        .select("workspace_id")
        .eq("id", leadId)
        .single();

      if (leadWs?.workspace_id && interactionRow) {
        await projectTimelineItem(supabase, {
          workspace_id: leadWs.workspace_id,
          lead_id: leadId,
          channel: "sms",
          provider: "twilio",
          direction: "outbound",
          event_type: "sms_outbound",
          occurred_at: interactionOccurredAt,
          source_table: "interactions",
          source_id: interactionRow.id,
          snippet_text: messageBody.substring(0, 500),
          metadata_json: { twilio_message_sid: messageSid, from: senderNumber, to },
          dedupe_key: dedupeKey,
        }).catch(e => console.warn("[sms-send] Timeline projection failed:", e));
      }

      // Update lead timestamps
      const effectiveUserId = ownerUserId || userId;
      if (skipStateUpdate) {
        console.log(`[sms-send] skipStateUpdate=true — only updating timestamps for lead ${leadId}`);
        await supabase
          .from("leads")
          .update({
            last_activity_at: new Date().toISOString(),
            last_outbound_at: new Date().toISOString(),
          })
          .eq("id", leadId);
      } else {
        // Manual send: update lead state
        await supabase
          .from("leads")
          .update({
            last_activity_at: new Date().toISOString(),
            last_outbound_at: new Date().toISOString(),
          })
          .eq("id", leadId);

        // Trigger AI analysis for manual sends
        try {
          const { data: leadData } = await supabase
            .from("leads")
            .select("stage, next_action_key, company, name")
            .eq("id", leadId)
            .single();

          if (leadData) {
            const analysisResponse = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": authHeader,
              },
              body: JSON.stringify({
                task: "analyze_outgoing_email",
                payload: {
                  lead_context: `Name: ${leadData.name}, Company: ${leadData.company}`,
                  current_stage: leadData.stage,
                  current_next_action: leadData.next_action_key || "none",
                  sent_email_subject: "(SMS)",
                  sent_email_body: messageBody,
                },
              }),
            });

            if (analysisResponse.ok) {
              const analysisData = await analysisResponse.json();
              if (analysisData.ok && analysisData.content) {
                try {
                  const analysis = JSON.parse(analysisData.content);
                  await supabase
                    .from("leads")
                    .update({
                      stage: analysis.suggested_stage || leadData.stage,
                      next_action_key: analysis.next_action_key,
                      next_action_label: analysis.next_action_label,
                      needs_action: analysis.needs_action ?? false,
                      action_instructions: null,
                    })
                    .eq("id", leadId);
                } catch (parseErr) {
                  console.error("[sms-send] Failed to parse AI analysis:", parseErr);
                }
              }
            }
          }
        } catch (aiError) {
          console.error("[sms-send] AI analysis error:", aiError);
        }
      }

      // Recompute needs_action / next_action_* now that the outbound is
      // persisted. Owns its own try/catch — never fails the send.
      postSendDeriveAction(supabase, { leadId, logPrefix: "[sms-send]" });
    } catch (err) {
      console.error("[sms-send] Background task error:", err);
    }
  };

  // Fire background tasks without blocking response
  backgroundTasks().catch(e => console.error("[sms-send] Background tasks failed:", e));

  return new Response(
    JSON.stringify({ ok: true, messageSid }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
