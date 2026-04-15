

## Fix: AI Recommending Past-Date Actions

### Problem
The LLM synthesis prompt in `recompute-lead-intelligence` has no awareness of the current date. It sees context items like "Next Milestone Date: 2025-11-10" and "Next step: Call week of 11/10/2025" and recommends them as future actions — even though those dates have already passed.

### Plan

**File: `supabase/functions/recompute-lead-intelligence/index.ts` (~line 485)**

1. **Inject current date into the prompt** — Add `Today's date: ${new Date().toISOString().slice(0, 10)}` to the lead info line so the LLM knows what "now" is.

2. **Add a temporal awareness rule** — Append to the Rules section:
   ```
   - Today's date is YYYY-MM-DD. NEVER recommend actions with dates in the past. If a context item references a past date, treat it as historical fact, not a pending action. Reframe past-due items as "overdue" or suggest an updated timeline.
   ```

That's it — two lines added to the prompt. The LLM already has the reasoning capability; it just needs the temporal anchor.

### Impact
- Next step recommendations will no longer reference past dates
- Past-due milestones will be framed as overdue or rescheduled
- Existing leads need a re-analysis (click "Run Analysis") to pick up the fix

