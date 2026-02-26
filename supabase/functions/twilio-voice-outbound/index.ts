// ============================================================
// Twilio Voice Outbound — Click-to-call via Twilio REST API
// Authenticated endpoint: creates call with recording + callbacks
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { CALL_DEFAULTS } from "../_shared/callConfig.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN");

  // ---- Authenticate user ----
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const token = authHeader.replace("Bearer ", "");
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: claimsData, error: claimsErr } = await userClient.auth.getClaims(token);
  if (claimsErr || !claimsData?.claims) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userId = claimsData.claims.sub as string;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();
    const { toNumber, fromNumber, leadId } = body as {
      toNumber?: string;
      fromNumber?: string;
      leadId?: string;
    };

    if (!toNumber || !fromNumber) {
      return new Response(JSON.stringify({ ok: false, error: "toNumber and fromNumber are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate input format (E.164)
    const e164Regex = /^\+[1-9]\d{1,14}$/;
    if (!e164Regex.test(toNumber) || !e164Regex.test(fromNumber)) {
      return new Response(JSON.stringify({ ok: false, error: "Phone numbers must be in E.164 format (+1234567890)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!twilioSid || !twilioToken) {
      return new Response(JSON.stringify({ ok: false, error: "Twilio credentials not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load workspace settings for recording notice
    const { data: settings } = await supabase
      .from("call_settings")
      .select("recording_notice_enabled")
      .limit(1)
      .maybeSingle();

    const recordingNotice = settings?.recording_notice_enabled ?? CALL_DEFAULTS.RECORDING_NOTICE_ENABLED;

    // Build TwiML URL for the call — the inbound handler will play notice + dial
    const twimlUrl = `${supabaseUrl}/functions/v1/twilio-voice-inbound`;
    const statusCallbackUrl = `${supabaseUrl}/functions/v1/twilio-voice-webhook`;

    // Create call via Twilio REST API
    const twilioApiUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls.json`;
    const twilioAuth = btoa(`${twilioSid}:${twilioToken}`);

    const callParams = new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      Url: twimlUrl,
      Method: "POST",
      StatusCallback: statusCallbackUrl,
      StatusCallbackMethod: "POST",
      StatusCallbackEvent: "initiated ringing answered completed",
    });

    const twilioResp = await fetch(twilioApiUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${twilioAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: callParams.toString(),
    });

    const twilioBody = await twilioResp.json();

    if (!twilioResp.ok) {
      logger.error("outbound_call_twilio_error", {
        status: twilioResp.status,
        error: twilioBody,
      });
      return new Response(JSON.stringify({ ok: false, error: "Failed to initiate call", details: twilioBody.message }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const callSid = twilioBody.sid;

    // Pre-create call session so webhook updates find it
    // Resolve workspace
    const { data: wsSettings } = await supabase
      .from("call_settings")
      .select("workspace_id")
      .limit(1)
      .maybeSingle();

    const workspaceId = wsSettings?.workspace_id;
    if (!workspaceId) {
      logger.warn("outbound_no_workspace", { callSid });
    }

    if (workspaceId) {
      const { error: insertErr } = await supabase.from("call_sessions").insert({
        call_sid: callSid,
        workspace_id: workspaceId,
        direction: "outbound",
        from_number: fromNumber,
        to_number: toNumber,
        status: "initiated",
        started_at: new Date().toISOString(),
        agent_user_id: userId,
        lead_id: leadId ?? null,
      });

      if (insertErr && insertErr.code !== "23505") {
        logger.error("outbound_session_insert_error", { error: insertErr.message });
      }
    }

    logger.info("outbound_call_initiated", { callSid, toNumber, userId });

    return new Response(JSON.stringify({
      ok: true,
      callSid,
      status: "initiated",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error("outbound_call_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response(JSON.stringify({ ok: false, error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
