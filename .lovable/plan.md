

## Timeline Email Filtering & Cleanup

### Problem
The timeline shows all synced emails, including irrelevant ones (newsletters, auto-replies, CC'd mass emails, etc.) that clutter the lead's activity feed and pollute AI context.

### Solution: Two-Part Approach

#### Part 1: Add a `hidden` column to `interactions` + Delete/Hide UI

Add a `hidden` boolean column (default `false`) to the `interactions` table. This allows users to mark irrelevant emails as hidden without permanently deleting data (which could break metrics).

**SQL Migration:**
```sql
ALTER TABLE interactions ADD COLUMN hidden boolean NOT NULL DEFAULT false;
CREATE INDEX idx_interactions_hidden ON interactions (lead_id, hidden) WHERE hidden = false;
```

**Query changes:**
- `getLeadInteractions` in `supabaseQueries.ts`: add `.eq("hidden", false)` filter
- `contextResolver.ts` (feeds AI drafts): also filter hidden interactions so irrelevant emails don't pollute AI-generated content

**UI changes in `TimelineTab.tsx`:**
- Add a small "Hide" button (trash/eye-off icon) on each timeline entry
- Clicking it sets `hidden = true` on that interaction row
- Add a "Show hidden" toggle at the top to reveal hidden items (greyed out, with "Unhide" option)

#### Part 2: Type-based filter bar

Add a filter bar at the top of the timeline with toggle chips:
- **All** | **Emails** | **WhatsApp** | **Meetings** | **Notes**

This is purely client-side filtering on the already-loaded interactions array -- no backend changes needed.

### Technical Details

**Files to change:**

| File | Change |
|------|--------|
| SQL migration | Add `hidden` boolean column + index |
| `src/lib/supabaseQueries.ts` | Add `.eq("hidden", false)` to `getLeadInteractions`; add new `hideInteraction(id)` and `unhideInteraction(id)` functions |
| `src/lib/contextResolver.ts` | Hidden interactions are already excluded since it calls `getLeadInteractions` |
| `src/components/lead/TimelineTab.tsx` | Add filter bar (All/Emails/WhatsApp/Meetings/Notes), add Hide/Unhide buttons per entry, add "Show hidden" toggle |

**Hide interaction function:**
```typescript
export async function hideInteraction(interactionId: string): Promise<void> {
  const { error } = await supabase
    .from("interactions")
    .update({ hidden: true })
    .eq("id", interactionId);
  if (error) throw error;
}
```

**Filter bar behavior:**
- Default: "All" selected, hidden items excluded
- Chips are toggle buttons that filter the `interactions` array by `type`
- "Show hidden" is a secondary toggle that re-fetches with `hidden` filter removed

**Visual design:**
- Filter chips: small pill buttons matching existing badge style
- Hide button: subtle eye-off icon, appears on hover over each timeline entry
- Hidden items (when revealed): shown with reduced opacity and strikethrough subject
