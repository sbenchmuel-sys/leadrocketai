## What's going on

**Both issues have the same root cause: no campaign has ever been launched.**

### 1. Why all 3 campaigns show "Draft"

Checked the DB for your Binah workspace:

| Name | status | send_mode | enrollments |
|---|---|---|---|
| TEST 2 | draft | review | 0 |
| Test | draft | review | 0 |
| Inbound Intro 3 | draft | review | 8 |

Every campaign is created with `status='draft'` (by design — `campaignQueries.ts:226`), and there is currently **no UI anywhere that flips a campaign to `active`**. `CampaignDetail.tsx` only has a Pause ↔ Resume toggle, and it explicitly refuses to act unless the campaign is already `active` or `paused` (line 277, "otherwise Pause-then-Resume would activate a draft bypassing launch checks"). The launch button that comment refers to was never built.

So drafts are a one-way street today.

### 2. Why "Bob the Builder" doesn't show up in Queue → Outreach

Two reasons stack on top of each other:

a. **No lead named Bob exists in the Binah workspace.** The 10 most recent leads are `Achyutagrawal`, `Kino`, `Techsales`, `Nishant Chaturvedi`, `Keith Teh`, `Bar Talya`, `Takayuki Tonsho`, `Paolo Agnelli`, `Mwangai`, `Gregg Jackson` — no Bob, no "Test2". The Add-leads dialog likely errored or matched no rows; worth retrying and watching for a toast.

b. **Even if Bob were added, he still wouldn't appear.** `fetchOutreachQueue` (`src/lib/outreachQueue.ts:114-120`) only loads touches whose campaign is `status='active'`, and `campaign-touch-scheduler` only creates touches for active campaigns. Enrollment itself doesn't check status, so a draft campaign happily accepts leads — they just sit invisible forever. That's exactly what happened to the 8 leads enrolled in `Inbound Intro 3`.

## Fix

Add the missing **Launch** action on the campaign detail page so a rep can move a draft to active. Minimum viable, no behavior changes anywhere else.

### Scope

- **`src/pages/CampaignDetail.tsx`**
  - When `campaign.status === 'draft'`, render a primary `Launch outreach` button next to the existing Pause/Resume slot (which stays hidden for drafts as it is today).
  - Click → small `AlertDialog` confirm ("Start sending? Enrolled leads will begin receiving touches on schedule. Send mode: Review / Automatic.") → on confirm, `UPDATE campaigns SET status='active'` via a new `launchCampaign(id)` helper in `src/lib/outreachQueue.ts` (sits next to `pauseCampaign` / `resumeCampaign`). Optimistically update local state and toast `Outreach launched`.
  - Guard: require at least one active step AND at least one row in `campaign_step_content` for the campaign before allowing launch; if missing, the button is disabled with a tooltip "Add message content first." (Matches the existing safety posture — no silent activation.)
- **`src/pages/Automations.tsx`** (the list in the screenshot)
  - No behavior change. The "Draft" badge will simply disappear for campaigns the rep launches.

### Why this is small and safe

- No schema change, no edge function change, no scheduler change. The scheduler and `fetchOutreachQueue` already do the right thing once `status='active'`.
- Honors the existing automation-consent rule (explicit confirm dialog before any outbound goes live).
- Pause/Resume continues to work unchanged for active campaigns.

### What you should see after the fix

1. Open `Test` → click `Launch outreach` → confirm.
2. Add Bob the Builder via "Add people" (and check the toast — if it says 0 enrolled, the lead row wasn't created, which is a separate Add-leads issue I'd dig into next).
3. Bob's first touch (delay_days=0 step) appears in **Queue → Outreach** within seconds. Subsequent touches surface as their `eligible_at` is reached by the 5-min `campaign-touch-scheduler` cron.

### Out of scope (call out if you want them too)

- A bulk "Launch" affordance on the Outreach list page.
- Auto-backfilling touches for leads that were enrolled into `Inbound Intro 3` while it was still a draft — those 8 enrollments may need a one-time refresh; I'd verify behavior after launch and decide.
- Investigating the Add-leads dialog failure for "Bob the Builder" — needs a repro to see the error.
