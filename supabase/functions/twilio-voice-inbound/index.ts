// ============================================================
// Twilio Voice Inbound — TwiML endpoint for incoming calls
// AND browser-originated outbound calls via Twilio Client SDK
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { validateTwilioSignature } from "../_shared/twilioSignature.ts";
import { resolveWorkspaceByAgentNumber } from "../_shared/phoneMapping.ts";
import {
  CALL_DEFAULTS,
  CALLEE_NOTICE_PARAM,
  CALLEE_NOTICE_VALUE,
  buildCalleeNoticeTwiml,
  buildOutboundDialTwiml,
  calleeNoticeUrl,
  escapeXml,
} from "../_shared/callConfig.ts";

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
    // Parse request body — Twilio sends application/x-www-form-urlencoded
    const contentType = req.headers.get("content-type") || "";
    let params: Record<string, string>;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      params = Object.fromEntries(formData) as Record<string, string>;
    } else {
      // Fallback for JSON (e.g. testing)
      params = await req.json();
    }

    logger.info("twilio_inbound_params", {
      To: params.To,
      From: params.From,
      Caller: params.Caller,
      Direction: params.Direction,
      CallSid: params.CallSid,
      AccountSid: params.AccountSid,
      ApiVersion: params.ApiVersion,
    });

    // ---------------------------------------------------------------
    // Twilio signature validation — FIRST, for EVERY branch (C1/3).
    //
    // This used to sit AFTER the browser branch, so anyone who could POST
    // `Caller=client:user_<uuid>` to this URL got TwiML that dials any number
    // on the workspace's Twilio account: unauthenticated toll fraud.
    //
    // Browser (Twilio Client SDK) calls reach this function the SAME way an
    // inbound PSTN call does — as an HTTP request FROM Twilio's servers against
    // the TwiML App's Voice URL — so Twilio signs them identically and there is
    // no reason to exempt them. Validation is against the public SUPABASE_URL
    // (same fix as sms-webhook): Twilio signs the URL it was configured with,
    // not the internal container URL `req.url` returns.
    //
    // ponytail: this REQUIRES the TwiML App Voice URL to be exactly
    //   <SUPABASE_URL>/functions/v1/twilio-voice-inbound
    // with no query string and no custom domain. Ceiling: if the console is
    // configured with a different host or a `?foo=bar` suffix, every browser
    // call fails closed with "Unauthorized" instead of dialing. Upgrade path is
    // to validate against a small allowlist of configured URLs, but the tight
    // check is the correct default for a toll-fraud surface.
    // ---------------------------------------------------------------
    const signature = req.headers.get("X-Twilio-Signature");
    // Twilio signs the FULL url including its query string, so the query must be
    // carried over from the incoming request. The origin still comes from the
    // public SUPABASE_URL, never from `req.url` (which is the internal container
    // host). With no query string this is byte-identical to the plain function
    // URL, so the inbound and browser branches are unaffected; it is the
    // `?leg=callee_notice` fetch that needs it, and if this were wrong that
    // fetch would 403 and the prospect's leg would be dropped mid-dial.
    const incomingQuery = new URL(req.url).search;
    const fnUrl = `${supabaseUrl}/functions/v1/twilio-voice-inbound`;
    const publicUrl = `${fnUrl}${incomingQuery}`;
    const isValid = twilioAuthToken && signature
      ? await validateTwilioSignature(twilioAuthToken, signature, publicUrl, params)
      : false;
    if (!isValid) {
      logger.warn("inbound_signature_rejected", {
        reason: !twilioAuthToken ? "no_auth_token" : !signature ? "no_signature" : "invalid_signature",
        caller: params.Caller,
      });
      return new Response("<Response><Say>Unauthorized</Say></Response>", {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "text/xml" },
      });
    }

    // ---------------------------------------------------------------
    // Callee-leg recording notice (C1/4).
    //
    // Twilio fetches this when the CALLED party answers an outbound call, and
    // plays the response on THEIR leg before bridging them to the rep. It is a
    // branch of this function rather than a new function precisely so it is
    // covered by the signature validation above — it is a Twilio-facing URL like
    // any other, and an open one would let anyone make the workspace's Twilio
    // account speak.
    //
    // A `<Say>` on the rep's own <Dial> document would NOT work: that plays to
    // the rep before the number is even dialled, which is exactly the bug this
    // replaces.
    // ---------------------------------------------------------------
    if (new URL(req.url).searchParams.get(CALLEE_NOTICE_PARAM) === CALLEE_NOTICE_VALUE) {
      logger.info("callee_notice_played", { callSid: params.CallSid, to: params.To });
      return new Response(buildCalleeNoticeTwiml(), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/xml" },
      });
    }

    // ---------------------------------------------------------------
    // Browser-originated outbound call (Twilio Client SDK)
    // ---------------------------------------------------------------
    const clientToNumber = params.To ?? "";
    const callerIdentity = params.Caller ?? "";
    const isBrowserCall = callerIdentity.startsWith("client:");

    if (isBrowserCall && clientToNumber) {
      const toNormalized = clientToNumber.replace(/[^\d+]/g, "");

      if (!toNormalized.startsWith("+")) {
        return new Response(
          `<Response><Say>Invalid destination number.</Say></Response>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        );
      }

      // Resolve caller ID for this rep. Order (mirrors src/lib/repCallerNumber.ts,
      // the client-side resolver used by ClickToCallButton and the queue card):
      //   1. the rep's OWN number (rep_profiles.twilio_phone_number)
      //   2. the workspace default (call_settings.default_twilio_number)
      // Before C1 step 1 was missing entirely, so a rep with their own number
      // configured still dialed out from the shared workspace number (C1/5).
      //
      // Fail safe: if neither is configured we must NOT dial from any other
      // number — placing a call with a wrong caller ID is worse than not calling.
      let callerId: string | null = null;
      let resolvedWorkspaceId: string | null = null;
      let recordingNoticeEnabled: boolean = CALL_DEFAULTS.RECORDING_NOTICE_ENABLED;
      // Extract user ID from client identity (format: "client:user_<uuid>")
      const callerUserIdMatch = callerIdentity.match(/^client:user_(.+)$/);
      const callerUserId = callerUserIdMatch ? callerUserIdMatch[1] : null;

      try {
        if (callerUserId) {
          // 1. The rep's own Twilio number.
          const { data: repProfile } = await supabase
            .from("rep_profiles")
            .select("twilio_phone_number")
            .eq("user_id", callerUserId)
            .maybeSingle();

          // ponytail: `as any` because src/integrations/supabase/types.ts is
          // Lovable-generated and this column post-dates the last regeneration.
          // deno-lint-ignore no-explicit-any
          const repNumber = (repProfile as any)?.twilio_phone_number as string | null | undefined;
          if (repNumber) callerId = repNumber;

          // Find the rep's workspace (needed for the session row and settings
          // regardless of which number won).
          const { data: membership } = await supabase
            .from("workspace_members")
            .select("workspace_id")
            .eq("user_id", callerUserId)
            .limit(1)
            .maybeSingle();

          if (membership?.workspace_id) {
            resolvedWorkspaceId = membership.workspace_id as string;
            const { data: callSettings } = await supabase
              .from("call_settings")
              .select("default_twilio_number, recording_notice_enabled")
              .eq("workspace_id", resolvedWorkspaceId)
              .maybeSingle();

            // 2. Workspace default, only when the rep has no number of their own.
            if (!callerId && callSettings?.default_twilio_number) {
              callerId = callSettings.default_twilio_number as string;
            }
            if (typeof callSettings?.recording_notice_enabled === "boolean") {
              recordingNoticeEnabled = callSettings.recording_notice_enabled;
            }
          }
        }
      } catch (lookupErr) {
        logger.warn("caller_id_lookup_failed", { error: String(lookupErr) });
        // Leave callerId unresolved → fail safe below.
      }

      // Fail safe: no configured caller ID → speak a message and hang up. Never dial.
      if (!callerId) {
        logger.warn("browser_call_no_caller_id", {
          userId: callerUserId,
          workspaceId: resolvedWorkspaceId,
        });
        return new Response(
          `<Response><Say voice="Polly.Joanna">No calling number is set up for your account. Please set one in settings, then try again.</Say><Hangup/></Response>`,
          { status: 200, headers: { ...corsHeaders, "Content-Type": "text/xml" } },
        );
      }

      // Build callback URLs for status tracking & recording
      const statusCallbackUrl = `${supabaseUrl}/functions/v1/twilio-voice-webhook`;
      const recordingCallbackUrl = `${supabaseUrl}/functions/v1/twilio-voice-webhook`;

      // Also pre-create the call_session row so it exists immediately
      // (the webhook will update it as status changes come in)
      const callSid = params.CallSid ?? "";
      const browserLeadId = params.LeadId ?? null;

      if (resolvedWorkspaceId && callSid) {
        const { error: sessionErr } = await supabase.from("call_sessions").insert({
          call_sid: callSid,
          workspace_id: resolvedWorkspaceId,
          direction: "outbound",
          from_number: callerId,
          to_number: toNormalized,
          status: "initiated",
          started_at: new Date().toISOString(),
          agent_user_id: callerUserId,
          lead_id: browserLeadId,
        });
        if (sessionErr && sessionErr.code !== "23505") {
          logger.error("browser_call_session_insert_error", { error: sessionErr.message });
        } else {
          logger.info("browser_call_session_created", { callSid, wsId: resolvedWorkspaceId, leadId: browserLeadId });
        }
      }

      // The outbound leg records exactly like the inbound leg, so the CALLED
      // party gets the same spoken recording notice (C1/4). It is delivered via
      // the `url` on <Number> — i.e. on the prospect's leg after they answer —
      // NOT as a <Say> on this document, which only the rep would hear.
      const twiml = buildOutboundDialTwiml({
        to: toNormalized,
        callerId,
        statusCallbackUrl,
        recordingCallbackUrl,
        recordingNotice: recordingNoticeEnabled,
        calleeNoticeUrl: calleeNoticeUrl(fnUrl),
      }).trim();

      logger.info("browser_outbound_call", { to: toNormalized, callerId, twiml });

      return new Response(twiml, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    // ---------------------------------------------------------------
    // Standard inbound call flow (phone → Twilio → rep)
    // ---------------------------------------------------------------
    const toNumber = params.To ?? "";

    // ---- Resolve the WORKSPACE, then load ITS settings ----
    // This was an unscoped `.limit(1)` — the same "grab whichever row comes
    // first" pattern removed from phoneMapping.ts in C1/9. On a second tenant it
    // would apply another workspace's recording policy to this call.
    //
    // But a raw string `.eq("default_twilio_number", toNumber)` is not enough
    // either: a stored "+1 (415) 555-0123" would not equal Twilio's
    // "+14155550123", no row would match, and `recording_require_dtmf_consent`
    // would silently fall back to OFF — losing the press-1 consent gate in a
    // two-party-consent state. That is the exact failure mode this unit exists
    // to close, so resolution is deliberately layered:
    //   1. normalized E.164 match on the dialed number (shared matcher, so the
    //      rule has one definition — phoneMapping.matchWorkspaceByNumber);
    //   2. failing that, the workspace on an existing call_sessions row for this
    //      CallSid (a status callback may already have created it);
    //   3. only when there is genuinely NO workspace, CALL_DEFAULTS — and that
    //      is logged at error level, because it means a live call is being
    //      handled under guessed consent settings.
    let settingsWorkspaceId = await resolveWorkspaceByAgentNumber(supabase, toNumber);

    if (!settingsWorkspaceId && params.CallSid) {
      const { data: existingSession } = await supabase
        .from("call_sessions")
        .select("workspace_id")
        .eq("call_sid", params.CallSid)
        .maybeSingle();
      settingsWorkspaceId = (existingSession?.workspace_id as string | undefined) ?? null;
    }

    let settings: { recording_notice_enabled?: boolean; recording_require_dtmf_consent?: boolean } | null = null;
    if (settingsWorkspaceId) {
      const { data } = await supabase
        .from("call_settings")
        .select("recording_notice_enabled, recording_require_dtmf_consent")
        .eq("workspace_id", settingsWorkspaceId)
        .maybeSingle();
      settings = data ?? null;
    } else {
      logger.error("inbound_call_settings_no_workspace", {
        to: toNumber,
        callSid: params.CallSid,
        note: "recording consent settings fell back to CALL_DEFAULTS — check call_settings.default_twilio_number",
      });
    }

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
  <Dial record="record-from-answer-dual" recordingStatusCallback="${escapeXml(recordingCallbackUrl)}" recordingStatusCallbackEvent="completed" recordingChannels="2">
    <Number statusCallback="${escapeXml(statusCallbackUrl)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${escapeXml(toNumber)}</Number>
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
  <Dial record="record-from-answer-dual" recordingStatusCallback="${escapeXml(recordingCallbackUrl)}" recordingStatusCallbackEvent="completed" recordingChannels="2">
    <Number statusCallback="${escapeXml(statusCallbackUrl)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${escapeXml(toNumber)}</Number>
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


