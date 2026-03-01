

# In-Browser Calling via Twilio Client SDK (WebRTC) — IMPLEMENTED

## What was built

### Backend
- **`twilio-voice-token`** — new edge function that generates short-lived Twilio Access Tokens with Voice Grant for the browser SDK
- **`twilio-voice-inbound`** — updated to detect browser-originated calls (via `client:` prefix in Caller param) and bridge them to the lead's phone number with recording

### Frontend
- **`BrowserCallProvider`** — React context that initializes Twilio Device, manages call state, exposes `makeCall()`, `hangUp()`, `toggleMute()`
- **`ActiveCallBar`** — persistent floating bar during calls showing lead name, duration timer, mute/unmute, end call
- **`ClickToCallButton`** — refactored to use browser SDK instead of REST API phone bridging

### Secrets required
- `TWILIO_API_KEY` — Twilio API Key SID
- `TWILIO_API_SECRET` — Twilio API Key Secret
- `TWILIO_TWIML_APP_SID` — TwiML App SID (voice URL → twilio-voice-inbound)

### Twilio Console setup needed
1. Create TwiML App → Voice Request URL: `https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/twilio-voice-inbound`
2. Create API Key pair
3. Store all 3 values as secrets (done)
