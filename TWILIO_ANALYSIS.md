# DrivePilot — Twilio Integration Analysis

*Prepared June 7, 2026. Plain-language verdicts up top, technical detail below.*

## The short answer

DrivePilot already has a **complete, well-built Twilio integration** for calls, SMS, and WhatsApp. The code is mature — not a prototype. The call recording, transcript, and AI summary pipeline in particular is genuinely strong.

| Channel | Ready? | Verdict |
|---|---|---|
| **Calls** | ✅ Mostly ready | Full click-to-call, inbound, recording, transcript + AI recap. Two fixable limits (long-call size cap, hardcoded fallback number). |
| **SMS** | ✅ Ready (code) | Send, receive, delivery status all work. Needs A2P 10DLC registration with Twilio before US texting works — that's an account/paperwork step, not code. |
| **WhatsApp** | ⚠️ Partly ready | Code is built and credentials are encrypted, but it can only send *plain* messages. Business-initiated WhatsApp (outside a 24-hour reply window) needs approved "templates," which the code doesn't send yet. |
| **Transcripts + summary/recap** | ✅ Yes, fully built | Every qualifying call is transcribed, speaker-labelled, and turned into a short recap, long summary, action items, and recommended next steps. |

---

## 1. Are calls, SMS, and WhatsApp ready to use?

### Calls — yes, with two things to fix

What's already working:
- **Click-to-call from the browser** using Twilio's Voice SDK (reps dial leads from inside DrivePilot).
- **Inbound calls** routed via TwiML with an optional "this call may be recorded" notice and an optional "press 1 to consent" gate.
- **Outbound calls** via Twilio's REST API.
- **Dual-channel recording** (rep and customer on separate audio tracks — important for clean transcripts).
- **Status tracking** (ringing → answered → completed) written back idempotently, so duplicate Twilio callbacks don't create duplicate records.
- **Signature verification** on incoming webhooks (rejects forged requests).

Two real limitations to address:
1. **Long calls fail to transcribe.** There's a 12 MB audio size cap *before* the audio is split into chunks. A dual-channel call longer than roughly 6–7 minutes can exceed that and gets rejected outright with "Audio too large." Sales calls are often longer than that, so this matters. (`call-transcribe/index.ts`, `MAX_AUDIO_BYTES`.)
2. **Hardcoded fallback phone number** (`+14504004322`) in the inbound handler. If a workspace hasn't set its caller ID, calls fall back to this one number. Fine for a single pilot, risky as you add dealerships. (`twilio-voice-inbound/index.ts`.)

### SMS — yes (code), pending one Twilio account step

Sending, receiving replies, and delivery-status updates are all implemented with signature verification and automatic matching of replies back to the right lead. The only blocker is external: **US business texting requires A2P 10DLC registration** in the Twilio console. That's a compliance/account task, not a code change.

Minor note: inbound replies are matched to leads partly by "last 10 digits" of the phone number, which can occasionally match the wrong lead if two contacts share those digits. Low risk, worth knowing.

### WhatsApp — built, but one capability gap

The plumbing is all there: a provider for Twilio (and one for Meta directly), a connect flow, an inbound webhook, a health check, and **credentials stored encrypted**. However, the Twilio WhatsApp sender only sends a plain `Body` (and optional media). WhatsApp's rules mean you can only send free-form messages within 24 hours of the customer's last message; to start a conversation you must send a **pre-approved template** (Twilio calls this a `ContentSid`). That template path isn't wired in, so business-initiated WhatsApp outreach would fail until it's added. Plus WhatsApp requires Meta business (WABA) and template approval — again partly paperwork.

---

## 2. How to harden the tokens so it stays connected

There are **two different kinds of credentials** in play, and they behave differently:

**A. The account secret (`TWILIO_AUTH_TOKEN`)** — a long-lived master password used for outbound calls, SMS, WhatsApp, and webhook verification. It's stored as a server secret (good) but it's the *account-level* token.

**B. The browser call token** — a short-lived (1-hour) access token the browser uses to make/receive calls. This is the one that affects "staying connected" during a rep's workday.

Recommended hardening, simplest first:

1. **Add auto-reconnect to the browser call token (highest impact for "stays connected").** Today the app refreshes the token once when it's about to expire — but if that single refresh fails (a brief network blip), nothing retries and the rep silently drops to a disconnected state until they reload the page. Adding a retry + automatic re-registration would keep reps connected through network hiccups. (`BrowserCallProvider.tsx`, the `tokenWillExpire` handler.)

2. **Add a periodic "safety" token refresh** (e.g. every ~50 minutes regardless of expiry events) and re-register the device when the browser regains network/visibility. Cheap insurance against the device going stale.

3. **Switch from the master Auth Token to Twilio API Keys** for the server-side send/call functions. API Keys can be rotated or revoked individually without taking the whole account down. Right now, rotating the master token means updating it in several places at once or everything breaks. (CLAUDE.md already flags a related fragility: the anon key is hardcoded in 12 cron commands.)

4. **Make webhook signature checking fail-closed.** If `TWILIO_AUTH_TOKEN` is ever missing, the webhooks currently accept requests without verifying them ("development mode"). In production this should hard-reject instead.

5. **Per-dealership credentials, eventually.** Calls and SMS currently run through one shared Twilio account for everyone. WhatsApp already supports per-workspace encrypted credentials; bringing voice/SMS to the same model improves isolation as you scale beyond the pilot.

6. **Remove the unused buggy helper.** `validateTwilioRequest` in `twilioSignature.ts` validates against the wrong URL and would reject everything; the live webhooks correctly use a different function. It's a trap for the next developer — delete it.

---

## 3. Are transcripts in line, with summary and recap after the call?

**Yes — this is the strongest part of the integration.** Here's the full automatic chain after a call ends:

1. Twilio finishes the recording and notifies DrivePilot.
2. The recording is downloaded and stored (with a checksum), short calls skipped to save cost.
3. **Transcription** (`call-transcribe`) via Google Speech-to-Text:
   - Speaker labels ("Agent" vs "Customer"), assigned by call direction.
   - Timestamps on every segment.
   - Automatic language detection (English, Spanish, French-Canadian configured).
   - Filler-word and repetition cleanup.
   - Stores three versions: raw, cleaned, and an LLM-ready timestamped transcript.
4. **AI analysis** (`call-analyze`) via Google Gemini, producing:
   - **`summaryShort`** — a 1–2 sentence recap.
   - **`summaryLong`** — a 3–5 paragraph summary.
   - Outcome, intent, and a minute-by-minute **sentiment timeline**.
   - **Objections, commitments, risks, action items, and ranked next steps** — each backed by an exact quote from the transcript.
   - A verification step that **deletes any quote the AI invented** that isn't actually in the transcript (anti-hallucination).
5. The recap is attached to the lead's timeline so reps see it in context.

So "transcript + summary + recap after the call" is fully delivered, and to a high standard.

Caveats worth knowing:
- **Duration gates:** calls under 10 seconds aren't transcribed; under 30 seconds aren't analyzed. Sensible, but be aware very short calls produce no recap.
- **The 12 MB cap** (from the Calls section) means long calls may never reach this pipeline at all — fixing that cap is what unlocks transcripts for your longer sales calls.
- **No automatic retry** if transcription fails — it can be re-run, but nothing re-runs it on its own. A small retry/alert would make this more reliable.

---

## Suggested priority order (simple → high value)

1. **Fix the 12 MB long-call cap** so real sales calls actually get transcribed. *(Biggest functional win.)*
2. **Add browser-token auto-reconnect + retry** so reps stay connected all day. *(Biggest "stays connected" win.)*
3. **Wire up WhatsApp templates** if you want to *start* WhatsApp conversations (not just reply).
4. **Move to Twilio API Keys** and make signature checks fail-closed. *(Security/operational hardening.)*
5. Complete the external paperwork: **A2P 10DLC** (SMS) and **WhatsApp/WABA + template approval**.

---

*Files reviewed: `twilio-voice-token`, `twilio-voice-inbound`, `twilio-voice-outbound`, `twilio-voice-webhook`, `call-ingest-recording`, `call-transcribe`, `call-analyze`, `_shared/asrProvider.ts`, `_shared/callConfig.ts`, `_shared/twilioSignature.ts`, `sms-send`, `sms-webhook`, `whatsapp-connect-twilio`, `_shared/whatsapp/providers/twilio.ts`, `BrowserCallProvider.tsx`, `supabase/config.toml`, `KNOWN_ISSUES.md`.*
