# Twilio Follow-up Fixes — Claude Code Prompts

Two independently shippable trust fixes. **Do them one at a time**, and run each through the
drivepilot-qa skill before shipping. Unit 2 is the higher-risk one (company data separation) —
QA it carefully.

---

## Unit 1 — Stop calls dialing from a hardcoded wrong number

```
In supabase/functions/twilio-voice-inbound/index.ts there is a hardcoded fallback caller ID
(FALLBACK_CALLER_ID = "+14504004322") used for browser-originated outbound calls when a
workspace has not set call_settings.default_twilio_number. This means a call can be placed
showing an arbitrary/wrong number as caller ID — a real problem as more workspaces onboard.

Change the behavior to FAIL SAFE instead of dialing from a wrong number:
1. Remove the hardcoded FALLBACK_CALLER_ID constant entirely.
2. In the browser-call branch (callerIdentity.startsWith("client:")), after attempting to
   resolve the user's workspace call_settings.default_twilio_number: if NO number is configured,
   do NOT dial. Return TwiML that speaks a brief message
   ("No calling number is set up for your account. Please set one in settings, then try again.")
   followed by <Hangup/>, and log a warning including the userId and resolved workspace.
3. Leave the successful path unchanged when a number IS configured.
4. Do not change the Twilio signature validation or the standard inbound (customer -> rep) flow.

Acceptance:
- A browser click-to-call from a workspace WITH a configured number works exactly as today.
- A workspace with NO configured number hears the message and the call does NOT dial out from
  any other number.
- grep confirms the literal +14504004322 no longer appears anywhere in the file.
Keep changes within twilio-voice-inbound/index.ts.
```

---

## Unit 2 — Make incoming texts match the right company only

```
In supabase/functions/sms-webhook/index.ts the inbound-SMS-to-lead match currently queries the
leads table GLOBALLY by phone number (phone.eq / +digits / ilike on last-10) with limit 5 and
picks leads[0], only loosely disambiguating by the receiving Twilio number afterward. With
shared or colliding numbers this can attach an inbound text to a lead in the WRONG workspace —
i.e. one company seeing another company's incoming message. Make it workspace-safe.

1. First resolve which workspace owns the RECEIVING number (params.To): find the workspace whose
   workspaces.default_sms_number OR call_settings.default_twilio_number matches the To number,
   comparing on digits only (reuse the existing digits() helper).
2. If exactly one workspace owns that number: restrict the lead lookup to that workspace_id and
   match the sender (From) by phone WITHIN that workspace only. Never select a lead outside it.
3. If the receiving number maps to NO workspace, or to MORE THAN ONE (shared number): fall back
   to today's best-effort global match, but log a clear warning "sms_inbound_unscoped_match"
   with the To number and candidate count, so these cases are visible.
4. Preserve everything else exactly: the dedupe_key logic, the interaction + timeline writes,
   the lead-timestamp update, the recompute trigger, and all the 200 / empty-TwiML responses
   (Twilio must never be told to retry).
5. Do NOT touch the X-Twilio-Signature verification — it must keep using TWILIO_AUTH_TOKEN.

Acceptance:
- An inbound SMS to a workspace's number attaches to a lead in THAT workspace.
- A lead in a different workspace that happens to share the sender's last-10 digits is NEVER
  selected when the receiving number identifies a single workspace.
- Unknown/shared receiving numbers still match as before, but now emit the warning log.
Keep changes within sms-webhook/index.ts.
```

---

## Parked (do NOT build now — noted so they don't get lost)

- **Per-dealership Twilio accounts/credentials** — proper isolation + independent key rotation,
  but a large rebuild and premature for the current pilot. Units 1 and 2 remove the immediate
  risks. Add to KNOWN_ISSUES.md.
- **Auto-retry for failed long-call transcripts** — small reliability win for the call recaps;
  worth a dedicated prompt later, not urgent.
```
