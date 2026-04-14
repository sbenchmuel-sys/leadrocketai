

## Problem

Calls to Canadian numbers (+1514...) fail instantly (0-second duration, status "failed") while calls to Israel (+972...) succeed. The Twilio account shows "Missing Business Profile" which restricts call capabilities.

## Root Cause

Twilio restricts outbound calling capabilities on accounts without an approved Business Profile. This particularly affects domestic North American (NANPA +1) numbers. The code and phone number formatting are correct — E.164 normalization is working properly.

## Plan

### Step 1: Twilio Account Fix (User Action Required)
- Go to **Twilio Console → Account → Business Profiles** and create/submit a Business Profile
- This removes the CPS=1 limitation and unlocks full North American calling
- Approval typically takes 1-3 business days

### Step 2: Add Diagnostic Error Surfacing (Code Change)
Improve `twilio-voice-inbound` and `BrowserCallProvider` to capture and display the actual Twilio error reason when a call fails, so future failures show a clear message (e.g., "Call rejected by carrier" or "Account restriction") instead of a generic WebSocket error.

- **`twilio-voice-inbound`**: Add logging of the Twilio error code from status callbacks
- **`twilio-voice-webhook`**: Store the Twilio `ErrorCode` field from status callbacks into `call_sessions` (add an `error_code` column)
- **`BrowserCallProvider`**: Map known Twilio error codes (21215, 21214, 13227) to user-friendly messages

### Step 3: Verify After Profile Approval
- Re-test calling a Canadian number once the Business Profile is approved
- Confirm the call completes and the transcript/analysis pipeline triggers

## Technical Details

The call flow works correctly (token generation succeeds, TwiML is valid). The failure happens at Twilio's network layer before the child leg connects — this is why `twilio-voice-inbound` shows zero recent logs for Canadian calls and the call sessions show 0-second duration. Adding an `error_code` text column to `call_sessions` and parsing the `ErrorCode` parameter from Twilio status webhooks will make future debugging immediate.

