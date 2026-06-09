# Twilio API Keys — Hardening Task (checklist + dev prompt)

## Why do this (plain language)

Right now most of DrivePilot's outbound Twilio actions (sending SMS, placing calls,
downloading recordings, sending WhatsApp) authenticate with your **master Auth Token** —
the account-level "root password." If it ever leaks or has to be rotated, *everything*
breaks at once and the whole account is exposed.

A Twilio **API Key** is a separate, named credential you can **revoke or rotate on its own**
without disturbing the master token. It's the recommended way to authenticate production
traffic.

Good news: **your browser calling feature already uses an API Key** (`TWILIO_API_KEY` +
`TWILIO_API_SECRET` are already configured). This task simply brings the remaining outbound
calls onto that same key.

## The one critical rule

**Webhook signature verification must keep using `TWILIO_AUTH_TOKEN`.** Twilio signs the
webhooks it sends you with the Auth Token, and an API Key secret *cannot* verify those
signatures. So we change only the **outbound** (DrivePilot → Twilio) calls. We do **not**
touch the inbound signature checks in `sms-webhook`, `twilio-voice-webhook`,
`twilio-voice-inbound`, or `whatsapp-webhook-twilio`.

---

## Part A — Twilio Console checklist (you do this, ~5 minutes)

You may already have a usable key (the one powering browser calls). If you want a fresh,
dedicated one for server traffic:

1. Go to the Twilio Console → **Account → API keys & tokens** (or search "API keys").
2. Click **Create API key**. Give it a name like `drivepilot-server`. Choose type
   **Standard** (Standard keys can send messages, place calls, and read recordings — that's
   all we need).
3. Twilio shows you a **SID** (starts with `SK...`) and a **Secret** — **copy the Secret now**,
   it is shown only once.
4. Confirm your account already has a working **Auth Token** (Console home) — we keep that for
   webhooks; don't change it.

If you'd rather reuse the existing key that browser calling uses, you can skip steps 1–3 — its
SID and secret are already stored as `TWILIO_API_KEY` and `TWILIO_API_SECRET`.

## Part B — Store the secrets

These names likely already exist (used by browser calling). Confirm in your Supabase project's
**Edge Function Secrets** (or have Lovable set them) that you have:

- `TWILIO_API_KEY` = the API Key SID (`SK...`)
- `TWILIO_API_SECRET` = the API Key Secret
- `TWILIO_ACCOUNT_SID` = your Account SID (`AC...`) — unchanged, still needed
- `TWILIO_AUTH_TOKEN` = your Auth Token — **keep it**, webhooks still use it

If `TWILIO_API_KEY` / `TWILIO_API_SECRET` are already set (they should be), there's nothing to add.

---

## Part C — Paste this prompt into your dev tool

```
Goal: move DrivePilot's OUTBOUND Twilio REST calls from master-Auth-Token auth to API Key auth,
without touching inbound webhook signature verification.

Background: Twilio REST calls authenticate with HTTP Basic auth. Today these use
btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`). Change them to use the API Key instead:
btoa(`${TWILIO_API_KEY}:${TWILIO_API_SECRET}`). The Account SID stays in the URL path
(https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/...) — only the Basic-auth
username:password changes. TWILIO_API_KEY (an SK... SID) and TWILIO_API_SECRET are already set
as secrets (the voice-token function already uses them).

Update the Basic-auth credential in exactly these outbound call sites:
1. supabase/functions/sms-send/index.ts            (the Messages.json POST)
2. supabase/functions/twilio-voice-outbound/index.ts (the Calls.json POST)
3. supabase/functions/call-ingest-recording/index.ts (the recording .wav download from Twilio)
4. supabase/functions/_shared/whatsapp/providers/twilio.ts (send() and checkHealth())
5. supabase/functions/_shared/asrProvider.ts        (TwilioAsrProvider — all Twilio API fetches)

For each: read TWILIO_API_KEY and TWILIO_API_SECRET; if BOTH are present, use them for Basic
auth; otherwise fall back to TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN so nothing breaks if the key
secrets are ever missing. Keep TWILIO_ACCOUNT_SID in the URL path in every case.

DO NOT CHANGE these — they verify inbound Twilio signatures and MUST keep using
TWILIO_AUTH_TOKEN:
- supabase/functions/sms-webhook/index.ts
- supabase/functions/twilio-voice-webhook/index.ts
- supabase/functions/twilio-voice-inbound/index.ts
- supabase/functions/whatsapp-webhook-twilio/index.ts
- supabase/functions/_shared/twilioSignature.ts
- supabase/functions/twilio-voice-token/index.ts (already uses the API key correctly)

Acceptance:
- Sending an SMS, placing an outbound call, downloading a recording, and sending a WhatsApp
  message all still succeed.
- Inbound SMS replies and call status/recording webhooks still pass signature verification.
- grep confirms no outbound REST call still hardcodes the Auth Token for Basic auth, and all
  four webhook validators still use TWILIO_AUTH_TOKEN.
Keep changes minimal; no schema or config changes needed.
```

---

## Part D — Test & rollback

**Test (after Lovable deploys):**
- Send a manual SMS from a lead → arrives, and a reply comes back into the timeline (proves
  outbound key works AND inbound webhook still verifies).
- Place a click-to-call → connects and the recording/recap appears (proves recording download
  works with the key).
- Send a WhatsApp reply → delivers.

**Rollback if anything misbehaves:** because the prompt keeps the Auth Token as a fallback,
you can revert instantly by clearing the `TWILIO_API_KEY` / `TWILIO_API_SECRET` secrets — the
code falls back to the old Auth-Token path. (Note: that would also affect browser calling,
which needs the key, so prefer reverting the code change instead if only one channel is off.)

**After it's proven:** once everything runs on the API Key for a while, you've gained the
ability to rotate that key on its own. You can also tighten further later by giving each
dealership/workspace its own key — but that's a separate, larger task.
```
