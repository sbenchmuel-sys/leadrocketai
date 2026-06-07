# DrivePilot — Ready-to-Paste Dev Prompts (Twilio fixes)

How to use: paste each prompt, one at a time, into your dev tool (Claude Code / Lovable).
They're ordered by priority. After a prompt that adds a migration or edge function,
remember the Lovable step: tell Lovable **"Apply migration `<filename>`"** so it runs against
the live database. Do them one at a time and test before moving on.

---

## Prompt 1 — Fix the long-call transcription cap (biggest functional win)

```
In supabase/functions/call-transcribe/index.ts there is a hard 12 MB audio cap
(MAX_AUDIO_BYTES = 12 * 1024 * 1024) that rejects calls outright with "Audio too large".
This blocks normal-length sales calls (a dual-channel WAV over ~6–7 minutes exceeds it)
from ever being transcribed.

The ASR provider in supabase/functions/_shared/asrProvider.ts ALREADY splits audio into
~55-second chunks before sending to Google Speech, so the whole file does not need to fit
in one request — the pre-check is the only blocker.

Please:
1. Raise the cap to a safe level for edge-function memory (target ~50 MB) instead of 12 MB,
   OR remove the single-buffer base64 step and stream/chunk directly so memory stays bounded.
2. Make sure a long multi-chunk call still completes within the edge function time limit; if
   transcription cannot finish, mark the transcript status "failed" with a clear reason rather
   than throwing, so it can be retried.
3. Do not change the duration gates (10s transcribe / 30s analyze) or the idempotency logic.
4. Add a log line with the audio size and number of chunks for observability.

Acceptance: a ~15-minute dual-channel test recording transcribes successfully end to end and
produces a call analysis. Keep changes minimal and within the existing file structure.
```

---

## Prompt 2 — Keep reps connected: auto-reconnect the browser call token (biggest "stays connected" win)

```
In src/components/call/BrowserCallProvider.tsx the Twilio Voice Device token is refreshed
only once via the "tokenWillExpire" handler, calling fetchToken() a single time with no retry.
If that one refresh fails (a brief network blip), nothing retries and the rep silently drops
to a disconnected state until they reload the page.

Please harden the connection without changing the calling UX:
1. In the tokenWillExpire handler, retry fetchToken() with exponential backoff (e.g. 3–4
   attempts) before giving up.
2. Add a periodic "safety" token refresh on a timer (~every 50 minutes) that refreshes and
   calls device.updateToken(), independent of the tokenWillExpire event.
3. Re-register the Device automatically when it goes unregistered or when the browser regains
   network/visibility (listen for the device "unregistered" event and the window "online" and
   "visibilitychange" events). Guard against duplicate registrations.
4. If all refresh attempts fail, surface a single non-spammy toast telling the rep to refresh.

Acceptance: simulate a network drop during an idle session — the device should recover and
return to "ready" on its own without a manual page reload. Do not introduce a second Device
instance; reuse deviceRef.
```

---

## Prompt 3 — Security/operational hardening: API Keys + fail-closed webhooks

```
Two hardening changes for the Twilio integration.

(A) Make webhook signature verification fail-closed.
Currently several webhook handlers only verify the X-Twilio-Signature if TWILIO_AUTH_TOKEN is
set, and otherwise accept the request ("development mode"). In production this should reject.
Files: supabase/functions/twilio-voice-webhook/index.ts, twilio-voice-inbound/index.ts,
sms-webhook/index.ts. Change the logic so that if TWILIO_AUTH_TOKEN is missing OR the signature
is missing/invalid, the request is rejected (403) — no silent allow path.

(B) Remove the buggy unused helper.
In supabase/functions/_shared/twilioSignature.ts, the function validateTwilioRequest() validates
against req.url (the internal container URL), which would reject all real Twilio requests. The
live webhooks correctly use validateTwilioSignature() with the public SUPABASE_URL instead.
Delete validateTwilioRequest() so no future code uses it by mistake. Confirm via grep that it
has no callers before deleting.

Do not change the working validateTwilioSignature() function. Keep the public-URL approach the
live webhooks already use.
```

> Note on switching from the master Auth Token to revocable Twilio **API Keys**: this is partly a
> Twilio Console step (create an API Key, then store its SID + Secret as new secrets) plus a code
> change to use them for outbound REST calls. It's worth doing but touches several files — tackle
> it as its own task after the above, or ask me to write a dedicated prompt + checklist for it.

---

## Prompt 4 — WhatsApp: support starting conversations with approved templates

```
In supabase/functions/_shared/whatsapp/providers/twilio.ts, the send() method only sends a plain
Body (and optional MediaUrl). WhatsApp only allows free-form messages within 24 hours of the
customer's last inbound message; to START a conversation you must send a pre-approved template,
which Twilio sends via a ContentSid (and ContentVariables) instead of Body.

Please:
1. Extend SendWhatsAppParams (in ../types.ts) and TwilioWhatsAppProvider.send() to optionally
   accept a contentSid and contentVariables (JSON). When contentSid is provided, send using
   Twilio's ContentSid/ContentVariables fields instead of Body.
2. Keep the existing plain-Body path working for replies inside the 24-hour window.
3. Do not hardcode any template SID; it should be passed in by the caller.

Acceptance: an outbound WhatsApp send with a contentSid produces a valid Twilio Content API
request; a send without one behaves exactly as today. Keep changes within the provider + types.
```

---

## Not a code task — external paperwork (do in parallel)

- **SMS (US):** Register A2P 10DLC in the Twilio Console. Until this is approved, US business
  texting will be filtered/blocked regardless of code.
- **WhatsApp:** Set up the Meta WhatsApp Business Account (WABA) and get your message templates
  approved by Meta. Prompt 4 only enables the code path; the templates themselves are approved
  in Meta/Twilio.
