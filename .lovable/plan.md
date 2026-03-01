

## In-Browser Calling via Twilio Client SDK (WebRTC)

Currently, clicking "Call" triggers Twilio to ring your physical phone first, then bridges to the lead. You want calls to happen directly in the browser using your microphone — no phone needed.

### How it works

Twilio's Client JS SDK uses WebRTC to turn your browser into a softphone. The flow:
1. Browser requests a short-lived access token from the backend
2. Twilio Client SDK connects via WebRTC using that token
3. When you call a lead, audio goes browser → Twilio → lead's phone
4. All existing recording, transcription, and analysis pipelines remain unchanged

### What needs to happen

**1. New secret required: `TWILIO_API_KEY` + `TWILIO_API_SECRET` + `TWILIO_TWIML_APP_SID`**
- You'll create a TwiML App in Twilio Console (Voice → TwiML Apps) with the voice request URL set to your existing inbound handler: `https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/twilio-voice-inbound`
- You'll create an API Key pair in Twilio Console (Account → API Keys)
- These 3 values get stored as secrets

**2. New backend function: `twilio-voice-token`**
- Authenticated endpoint that generates a Twilio Access Token with a Voice Grant
- Token is scoped to the TwiML App and has a short TTL (10 min)
- Returns the token + the user's identity string

**3. Update outbound function: `twilio-voice-outbound`**
- Instead of creating a REST API call that rings a phone, it now returns TwiML connection parameters for the browser client to initiate the call directly

**4. New frontend component: `BrowserCallProvider`**
- Wraps the app, initializes the Twilio Device (from `@twilio/voice-sdk`)
- Manages device state: registering, ready, on-call, incoming
- Exposes `makeCall(toNumber, leadId)` and `hangUp()` via context

**5. Updated `ClickToCallButton`**
- Uses the BrowserCallProvider context instead of calling the outbound REST endpoint
- Shows active call UI (duration timer, mute, hang up) inline
- Confirmation dialog updated to say "Call via browser" instead of "your phone will ring"

**6. New `ActiveCallBar` component**
- Floating bar at top/bottom of screen during an active call showing: lead name, duration, mute/unmute, hold, hang up
- Persists across page navigation

### Technical details

**NPM dependency:** `@twilio/voice-sdk` (Twilio's official browser Voice SDK)

**Token endpoint response:**
```json
{ "token": "eyJ...", "identity": "user_<uuid>" }
```

**TwiML App flow:** When the browser SDK connects, Twilio hits the TwiML App URL with a `connect` event. The inbound handler needs a small update to detect browser-originated calls (checking for `ClientCallSid` param) and return `<Dial>` TwiML to bridge to the lead's number.

**Inbound handler update:** Add logic to detect when `params.ClientCallSid` exists or `Direction === "inbound"` from a Client, extract the `toNumber` from custom parameters passed by the SDK, and dial that number.

**Recording:** Stays the same — `record="record-from-answer-dual"` in the `<Dial>` verb captures both sides.

### Files to create/modify

| Action | File |
|--------|------|
| Create | `supabase/functions/twilio-voice-token/index.ts` |
| Modify | `supabase/functions/twilio-voice-inbound/index.ts` (handle Client-originated calls) |
| Create | `src/components/call/BrowserCallProvider.tsx` |
| Create | `src/components/call/ActiveCallBar.tsx` |
| Modify | `src/components/call/ClickToCallButton.tsx` (use browser SDK) |
| Modify | `src/App.tsx` (wrap with BrowserCallProvider) |
| Modify | `supabase/config.toml` (add token function config) |
| Install | `@twilio/voice-sdk` |

