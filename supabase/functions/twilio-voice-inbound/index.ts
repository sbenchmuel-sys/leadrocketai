// ============================================================
// Twilio Voice Inbound — TwiML endpoint for incoming calls
// Plays recording notice, optional DTMF consent, then dials
// with dual-channel recording enabled
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
      const isValid = await validateTwilioSignature(twilioAuthToken, signature, req.url, params);
      if (!isValid) {
        logger.warn("inbound_signature_invalid");
        return new Response("<Response><Say>Unauthorized</Say></Response>", {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "text/xml" },
        });
      }
    }

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
        // User declined recording consent
        logger.info("inbound_dtmf_declined", { from: params.From });
        return new Response(
          `<Response><Say>Thank you. Goodbye.</Say><Hangup/></Response>`,
          { status: 200, headers: { ...corsHeaders, "Content-Type": "text/xml" } },
        );
      }
      // User consented — proceed to dial
      return respondWithDial(toNumber, statusCallbackUrl, recordingCallbackUrl);
    }

    // ---- Initial call flow ----
    let twiml = "<Response>";

    // Recording notice
    if (recordingNotice) {
      twiml += `<Say voice="Polly.Joanna">This call may be recorded for quality and training purposes.</Say>`;
    }

    // DTMF consent gate
    if (requireDtmf) {
      const gatherUrl = `${supabaseUrl}/functions/v1/twilio-voice-inbound`;
      twiml += `<Gather numDigits="1" action="${escapeXml(gatherUrl)}" method="POST">`;
      twiml += `<Say voice="Polly.Joanna">Press 1 to continue, or hang up to decline.</Say>`;
      twiml += `</Gather>`;
      // If no input, hang up
      twiml += `<Say>No input received. Goodbye.</Say><Hangup/>`;
      twiml += "</Response>";

      return new Response(twiml, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/xml" },
      });
    }

    // No DTMF required — go straight to dial
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

/**
 * Build TwiML response with Dial + dual-channel recording
 */
function respondWithDial(
  toNumber: string,
  statusCallbackUrl: string,
  recordingCallbackUrl: string,
): Response {
  // Dual-channel recording: record="record-from-answer-dual"
  // statusCallbackEvent covers full lifecycle
  const twiml = `<Response>
  <Dial
    record="record-from-answer-dual"
    recordingStatusCallback="${escapeXml(recordingCallbackUrl)}"
    recordingStatusCallbackEvent="completed"
    recordingChannels="2"
  >
    <Number
      statusCallback="${escapeXml(statusCallbackUrl)}"
      statusCallbackEvent="initiated ringing answered completed"
    >${escapeXml(toNumber)}</Number>
  </Dial>
</Response>`;

  return new Response(twiml, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
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
