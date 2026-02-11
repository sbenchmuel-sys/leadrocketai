

## Plan: Auto-Update Lead State on Email Upload + Meeting Summary Upload

### Problem 1: Lead card doesn't auto-update after uploading email history

When you upload interactions (e.g., inbound/outbound emails) via the Upload tab, the lead's `motion`, `stage`, `strategy`, and timestamps (`last_inbound_at`, `last_outbound_at`, `first_outbound_at`) are NOT recalculated. The lead keeps whatever defaults it was imported with.

**Fix:** After inserting an interaction in the Upload tab, run a stage-derivation update on the lead:
- If an **inbound email** is uploaded: set `last_inbound_at`, derive stage to at least `engaged`, and if the lead was `outbound_prospecting` with no prior inbound, the automation should reflect "Paused - Reply Received"
- If an **outbound email** is uploaded: set `last_outbound_at` / `first_outbound_at`
- If **email history is present** (any inbound exists): automation status should show paused/off accordingly
- Recalculate `stage` using the existing priority hierarchy (closed > closing > post_meeting > engaged > contacted > new)
- Refresh the lead data after update so the header and overview panel reflect changes immediately

### Problem 2: No place to upload meeting summaries in the Meetings tab

Currently meeting notes can only be added via the Upload tab (interaction type "meeting"), but the Meetings tab shows "No Meetings Yet" with no upload option. Users expect to add meeting summaries directly from the Meetings tab.

**Fix:** Add a "Add Meeting Summary" button to the Meetings tab that opens an inline form or dialog for pasting meeting notes. When submitted, it runs the same AI pipeline (recap generation, milestone extraction, deal factors, next steps) that already exists in the Upload tab's `runMeetingPipeline` function, and creates a meeting pack.

---

### Technical Details

#### File: `src/components/lead/UploadTab.tsx`
- After `insertInteraction` succeeds, add a lead update step:
  - For `email_inbound`: update `last_inbound_at`, set `stage` to at least `engaged`
  - For `email_outbound`: update `last_outbound_at`, `first_outbound_at` (if null)
  - For `meeting`: update `stage` to `post_meeting`, set `meeting_summary_count` increment
- Call `onSuccess()` to trigger `handleUpdate` which reloads the lead and refreshes the header/overview panel

#### File: `src/components/lead/MeetingsTab.tsx`
- Add an "Add Meeting Summary" button (visible in both empty state and header area)
- When clicked, show a form with: Title (optional), Date, and Notes textarea
- On submit, call `createMeetingPack` with raw notes, then run the AI pipeline (reuse the same recap/milestones/factors/recommendations flow from UploadTab)
- Refresh the meetings list after completion

#### File: `src/components/lead/LeadDetailHeader.tsx`
- No changes needed — it already derives automation status from lead fields. Once the lead fields are updated correctly, it will auto-reflect.

