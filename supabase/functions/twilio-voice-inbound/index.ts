// ============================================================
// Twilio Voice Inbound — TwiML endpoint for incoming calls
// AND browser-originated outbound calls via Twilio Client SDK
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { validateTwilioSignature } from "../_shared/twilioSignature.ts";
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
  const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // Parse form data
    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = value.toString();
    });

    // Validate Twilio signature
    const signature = req.headers.get("X-Twilio-Signature");
    if (twilioAuthToken && signature) {
    const baseUrl = Deno.env.get("TWILIO_WEBHOOK_BASE_URL")
        ? `${Deno.env.get("TWILIO_WEBHOOK_BASE_URL").replace(/\/$/, "")}/twilio-voice-inbound`
        : req.url;
      const isValid = await validateTwilioSignature(twilioAuthToken, signature, baseUrl, params);
      if (!isValid) {
        logger.warn("inbound_signature_invalid");
        return new Response("<Response><Say>Unauthorized</Say></Response>", {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "text/xml" },
        });
      }
    }

    // ---------------------------------------------------------------
    // Browser-originated outbound call (Twilio Client SDK)
    // When the browser SDK calls .connect(), Twilio hits this URL with
    // custom parameters. We detect this via the presence of a custom
    // "To" param set by the client SDK and the Direction being
    // "inbound" from the TwiML App perspective.
    // ---------------------------------------------------------------
    const clientToNumber = params.To ?? "";
    const direction = params.Direction ?? "";
    const callerIdentity = params.Caller ?? "";

    // Browser SDK calls include Caller starting with "client:" 
    const isBrowserCall = callerIdentity.startsWith("client:");

    if (isBrowserCall && clientToNumber) {
      // Validate E.164 destination
      const toNormalized = clientToNumber.replace(/[^\d+]/g, "");
      if (!toNormalized.startsWith("+")) {
        logger.error("browser_outbound_invalid_to", { to: clientToNumber });
        return new Response(
          "<Response><Say>Invalid destination number.</Say><Hangup/></Response>",
          { status: 200, headers: { ...corsHeaders, "Content-Type": "text/xml" } },
        );
      }

      // Resolve caller ID: param → call_settings → env fallback
      let fromNumber = (params.FromNumber ?? "").replace(/[^\d+]/g, "");
      if (!fromNumber || !fromNumber.startsWith("+")) {
        const { data: settings } = await supabase
          .from("call_settings")
          .select("default_twilio_number")
          .limit(1)
          .maybeSingle();
        fromNumber = settings?.default_twilio_number ?? "";
      }
      if (!fromNumber || !fromNumber.startsWith("+")) {
        fromNumber = Deno.env.get("TWILIO_PHONE_NUMBER") ?? "";
      }
      if (!fromNumber || !fromNumber.startsWith("+")) {
        logger.error("browser_outbound_no_caller_id");
        return new Response(
          "<Response><Say>No valid caller ID configured.</Say><Hangup/></Response>",
          { status: 200, headers: { ...corsHeaders, "Content-Type": "text/xml" } },
        );
      }

      // If Twilio account is trial, destination number must be verified.
      logger.info("browser_outbound_call", { to: toNormalized, callerId: fromNumber });

      const statusCallbackUrl = `${supabaseUrl}/functions/v1/twilio-voice-webhook`;

      const twiml = `<Response>
  <Dial callerId="${escapeXml(fromNumber)}" record="record-from-answer-dual" recordingStatusCallback="${escapeXml(statusCallbackUrl)}" recordingStatusCallbackEvent="completed" recordingChannels="2" statusCallback="${escapeXml(statusCallbackUrl)}" statusCallbackEvent="initiated ringing answered completed">
    <Number>${escapeXml(toNormalized)}</Number>
  </Dial>
</Response>`;

      return new Response(twiml.trim(), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/xml" },
      });
    }

    // ---------------------------------------------------------------
    // Standard inbound call flow (phone → Twilio → rep)
    // ---------------------------------------------------------------
    const toNumber = params.To ?? "";

    // Load workspace settings
    const { data: settings } = await supabase
      .from("call_settings")
      .select("*")
      .limit(1)
      .maybeSingle();

    const recordingNotice = settings?.recording_notice_enabled ?? CALL_DEFAULTS.RECORDING_NOTICE_ENABLED;
    const requireDtmf = settings?.recording_require_dtmf_consent ?? CALL_DEFAULTS.RECORDING_REQUIRE_DTMF_CONSENT;

    // Build callback URLs
    const statusCallbackUrl = `${supabaseUrl}/functions/v1/twilio-voice-webhook`;
    const recordingCallbackUrl = `${supabaseUrl}/functions/v1/twilio-voice-webhook`;

    // Check if this is a DTMF gather response
    const digits = params.Digits;
    if (requireDtmf && digits !== undefined) {
      if (digits !== "1") {
        logger.info("inbound_dtmf_declined", { from: params.From });
        return new Response(
          `<Response><Say>Thank you. Goodbye.</Say><Hangup/></Response>`,
          { status: 200, headers: { ...corsHeaders, "Content-Type": "text/xml" } },
        );
      }
      return respondWithDial(toNumber, statusCallbackUrl, recordingCallbackUrl);
    }

    // DTMF consent gate
    if (requireDtmf) {
      const gatherUrl = `${supabaseUrl}/functions/v1/twilio-voice-inbound`;
      const twiml = `<Response>
  ${recordingNotice ? `<Say voice="Polly.Joanna">This call may be recorded for quality and training purposes.</Say>` : ""}
  <Gather numDigits="1" action="${escapeXml(gatherUrl)}" method="POST">
    <Say voice="Polly.Joanna">Press 1 to continue, or hang up to decline.</Say>
  </Gather>
  <Say>No input received. Goodbye.</Say>
</Response>`;

      return new Response(twiml.trim(), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/xml" },
      });
    }

    // No DTMF — build inline TwiML with notice + dial
    if (recordingNotice) {
      const twiml = `<Response>
  <Say voice="Polly.Joanna">This call may be recorded for quality and training purposes.</Say>
  <Dial
    record="record-from-answer-dual"
    recordingStatusCallback="${escapeXml(recordingCallbackUrl)}"
    recordingStatusCallbackEvent="completed"
    recordingChannels="2"
    statusCallback="${escapeXml(statusCallbackUrl)}"
    statusCallbackEvent="initiated ringing answered completed">
    ${escapeXml(toNumber)}
  </Dial>
</Response>`;
      return new Response(twiml.trim(), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/xml" },
      });
    }

    // No notice, no DTMF — straight dial
    return respondWithDial(toNumber, statusCallbackUrl, recordingCallbackUrl);
  } catch (err) {
    logger.error("twilio_voice_inbound_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response(
      "<Response><Say>An error occurred. Please try again later.</Say></Response>",
      { status: 200, headers: { ...corsHeaders, "Content-Type": "text/xml" } },
    );
  }
});

function respondWithDial(
  toNumber: string,
  statusCallbackUrl: string,
  recordingCallbackUrl: string,
): Response {
  const twiml = `<Response>
  <Dial
    record="record-from-answer-dual"
    recordingStatusCallback="${escapeXml(recordingCallbackUrl)}"
    recordingStatusCallbackEvent="completed"
    recordingChannels="2"
    statusCallback="${escapeXml(statusCallbackUrl)}"
    statusCallbackEvent="initiated ringing answered completed">
    ${escapeXml(toNumber)}
  </Dial>
</Response>`;

  return new Response(twiml.trim(), {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Content-Type": "text/xml",
    },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
