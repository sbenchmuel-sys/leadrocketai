## Goal

Make LinkedIn a first-class cadence channel reps can add/edit in a campaign, and make the Queue's LinkedIn touch as low-effort as the browser allows (open the right URL + copy the right text + clear paste hint). Calls/SMS/WhatsApp stay exactly as they are today.

---

## Part A — Surface LinkedIn as a cadence channel (authoring)

### A1. `src/pages/NewCampaign.tsx`
- Add `linkedin` to `OPTIONAL_CHANNELS` with label "LinkedIn" and a one-line helper: "Manual touch — opens the lead's profile and copies the message for you to paste."
- Include it in the channel chooser shown on the cadence step so reps can opt in alongside Email / SMS / WhatsApp / Call.
- When LinkedIn is selected, seed defaults from the existing `src/lib/campaignDefaults.ts` LinkedIn plan (Connect, React, Message).

### A2. `src/lib/campaignDefaults.ts`
- Extend `EDITABLE_CHANNELS` to include `linkedin` so the step editor lets reps add a LinkedIn step or switch an existing step's channel to LinkedIn.
- Keep the three existing LinkedIn step subtypes available: **connection request**, **reaction**, **message**. These already exist in the defaults; just make sure the editor surfaces them as a subtype picker when channel = linkedin.

### A3. `src/components/automations/CampaignScript.tsx`
- Render LinkedIn steps with the same card shape as other manual channels (Linkedin icon from `lucide-react`, label "LinkedIn", subtype chip: "Connect" / "React" / "Message").
- Body editor: same Textarea as SMS/WhatsApp. For "React" the body is optional (no message to paste — just a hint to react on the latest post).

### A4. Skip-when-missing (already done — verify only)
- `supabase/functions/campaign-touch-scheduler/index.ts` already gates on `canReceive("linkedin")` (lead has `linkedin_url`). Confirm and leave alone.
- `OutreachCard.tsx` already gates the action with `linkedinNeedsUrl` → "No profile" disabled state. Leave alone.

---

## Part B — Make the Queue's LinkedIn action low-effort (runtime)

### B1. Per-subtype URL + clipboard, in `src/components/queue/OutreachCard.tsx` → `openChannelApp()` LinkedIn branch
Today: always opens `touch.linkedinUrl` (profile) and copies `body || talkingPoints`.

Replace with subtype-aware behavior, reading the subtype from the touch (we already have step metadata; expose `touch.linkedinAction: "connect" | "react" | "message"` on `OutreachTouch` in `src/lib/outreachQueue.ts`, defaulting to `"connect"` for back-compat):

- **connect** → open profile URL; copy the note body to clipboard. Toast: *"Note copied — click Connect → Add a note, then paste (⌘/Ctrl+V)."*
- **react** → open profile URL; do NOT copy anything. Toast: *"Opening their profile — react on their latest post."*
- **message** → open `https://www.linkedin.com/messaging/compose/`; copy the message body. Toast: *"Message copied — paste it in the chat (⌘/Ctrl+V)."* Fall back to the profile URL if compose isn't reachable (we don't store member IDs, so the compose page lands on the recipient picker — acceptable: rep types the name once).

Same behavior on desktop and mobile — LinkedIn handles app handoff via Universal/App Links automatically. No device branching.

### B2. `src/lib/outreachQueue.ts`
- Add `linkedinAction?: "connect" | "react" | "message"` to `OutreachTouch`.
- Populate it from `campaign_steps` step metadata in the existing loader (the field already exists in the defaults; just thread it through).

### B3. Clipboard fallback already covered
`src/lib/outreachDeepLinks.ts` → `copyToClipboard()` already handles the `navigator.clipboard` → `execCommand` fallback. No change.

---

## Part C — Out of scope (explicitly, per your confirmation)

- **No auto-paste** into LinkedIn's textbox — browsers forbid cross-origin paste. Not fixable.
- **No pre-filled message body** via URL — LinkedIn has no such parameter.
- **No changes to SMS, WhatsApp, or voice** paths. Desktop SMS/WhatsApp continue to open the rep's own apps via `sms:` / `wa.me`; desktop voice continues to use the in-app Twilio browser call; mobile continues to use native dialer / Messages / WhatsApp. No workspace toggle added.
- **No targeting a specific LinkedIn post** for the "react" step — we don't store post IDs.

---

## Verification

1. New campaign wizard: LinkedIn appears in the channel chooser; selecting it seeds Connect + React + Message steps with editable bodies.
2. Campaign editor: can add a LinkedIn step, switch subtype between Connect / React / Message, edit body.
3. Lead without `linkedin_url`: LinkedIn touch shows "No profile" disabled state in the Queue (existing behavior, confirm unchanged).
4. Lead with `linkedin_url`:
   - **Connect** → profile opens in new tab, note in clipboard, toast matches.
   - **React** → profile opens, no clipboard write, toast matches.
   - **Message** → messaging compose opens, body in clipboard, toast matches.
5. Existing tests pass: `src/lib/__tests__/linkedinCadence.test.ts`. Add a small unit test for the subtype→URL/clipboard picker.
