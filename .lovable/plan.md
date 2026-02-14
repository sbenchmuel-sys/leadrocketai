

## Fix: Leads List Shows Wrong Source & Email Composer Uses Wrong Playbook

### Two Bugs Identified

**Bug 1: Leads page shows "outbound" for all leads**
The `getLeadsList()` query only selects a limited set of columns and does NOT include `motion` or `source_type`. On the Leads page (line 429), the code does `(lead as any).motion?.replace(/_/g, ' ') || "outbound"` -- since `motion` is never fetched, it always falls back to "outbound".

**Bug 2: Email composer shows "Reply to Inbound" for new inbound leads with no email history**
When opening the composer for an inbound-website lead that has never been emailed, the playbook resolver's Rule 2 may incorrectly detect the lead's `initial_message` as an inbound email in the thread, causing it to recommend "Reply to Inbound" instead of "Inbound Intro". Additionally, the `getAITaskForAction` fallback (line 146 in EmailActionDialog) defaults to `reply_to_thread` if any thread exists, which is wrong for first-touch outreach to inbound leads.

---

### Fix 1: Add `motion` and `source_type` to the Leads List Query

**File: `src/lib/supabaseQueries.ts`**

- Update the `LeadListItem` type (line 91-94) to include `motion` and `source_type`
- Update the `.select()` call in `getLeadsList()` (line 110) to fetch these columns

**File: `src/pages/Leads.tsx`**

- Update the Strategy column (line 429) to use proper humanized labels from `SOURCE_TYPE_LABELS` instead of raw motion values. Display the source type (e.g., "Inbound - Website") rather than the motion.

---

### Fix 2: Correct Playbook Resolution for Fresh Inbound Leads

**File: `src/lib/playbookResolver.ts`**

- In `deriveDefault()` (line 159-183): The logic is actually correct -- it checks `hasThread` and returns "Inbound Intro" when there's no thread. The issue is upstream: the `contextResolver` may be picking up non-email interactions (like initial_message notes) as email thread items.

**File: `src/components/dashboard/EmailActionDialog.tsx`**

- Update `getAITaskForAction` default case (line 145-146): When the lead's motion is `inbound_response` and there's no prior outbound email in the thread, use `pre_email_1_intro` instead of `reply_to_thread`. This ensures first-touch emails to inbound leads use the intro playbook.
- Update `getPlaybookLabel` (line 102-124): Add source-type awareness so inbound leads show "Inbound Intro" instead of generic "Reply" when no outbound emails exist yet.

---

### Technical Summary

| File | Change |
|------|--------|
| `src/lib/supabaseQueries.ts` | Add `motion`, `source_type` to `LeadListItem` type and `getLeadsList` select |
| `src/pages/Leads.tsx` | Use `SOURCE_TYPE_LABELS` for the source column display |
| `src/components/dashboard/EmailActionDialog.tsx` | Fix `getAITaskForAction` default to use intro for inbound leads without outbound history |
| `src/lib/playbookResolver.ts` | No change needed -- logic is correct, issue was in consumer code |

