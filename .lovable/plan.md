
# Auto-Nurture Mode & Re-engagement Recommendations

## Overview
This plan connects the lead stages and cadence logic to enable automatic mode switching (fast → nurture) when prospects don't respond, and surfaces intelligent recommendations for re-engagement through nurture campaigns.

---

## 1. Database Schema Updates

### 1.1 Add Nurture Tracking Fields to Leads
Add new columns to support nurture mode tracking:

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS nurture_cadence TEXT CHECK (nurture_cadence IN ('weekly', 'biweekly', 'monthly'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS mode_changed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_nurture_eligible BOOLEAN DEFAULT false;
```

- `nurture_cadence`: The selected cadence when in nurture mode (weekly/biweekly/monthly)
- `mode_changed_at`: Timestamp when strategy was last changed (for analytics)
- `auto_nurture_eligible`: Flag set when lead meets criteria for auto-switch

---

## 2. Enhanced Mode Switching Logic

### 2.1 Update gmail-sync deriveAction
**File:** `supabase/functions/gmail-sync/index.ts`

Add new logic after breakup detection to suggest mode switching:

```text
BEFORE breakup email suggestion:
  - If lead is in "fast" mode AND
  - No reply after X follow-ups (e.g., 3+ outbound emails) AND
  - No inbound ever recorded AND
  - Days since first outbound > breakup trigger
  → Set auto_nurture_eligible = true
  → Suggest action: "Switch to nurture mode"
  → Return action_reason_code: "NURTURE_SWITCH_RECOMMENDED"
```

### 2.2 New Action Reason Code
**File:** `src/lib/cadenceSettingsTypes.ts`

Add new reason codes:
- `NURTURE_SWITCH_RECOMMENDED` - Suggest switching from fast to nurture
- `NURTURE_CAMPAIGN_START` - Suggest starting a nurture campaign

---

## 3. Dashboard Intelligence Enhancements

### 3.1 New "Nurture Candidates" Intelligence Widget
**File:** `src/components/dashboard/IntelligenceCards.tsx`

Add a fourth intelligence card showing leads recommended for nurture:
- Count of leads with `auto_nurture_eligible = true`
- Clickable to filter the lead table

### 3.2 Update Dashboard Stats Calculation
**File:** `src/lib/dashboardUtils.ts`

Add new function:
```typescript
function getNurtureCandidates(leads: EnrichedLead[]): EnrichedLead[] {
  // Leads that:
  // - Are in "fast" strategy
  // - Have sent 3+ outbound emails
  // - Have no inbound replies
  // - Are not in closing/closed stages
}
```

### 3.3 Enhanced AI Recommendation
**File:** `src/components/dashboard/AIRecommendation.tsx`

Update to include nurture-specific recommendations:
- "Consider moving [Lead] to nurture mode - no response after 4 emails"
- "[Lead] is ready for re-engagement after 45 days"
- "Start a monthly nurture campaign for [Lead] with industry insights"

---

## 4. Nurture Mode Switch UI

### 4.1 Quick Action: Switch to Nurture
**File:** `src/components/dashboard/ActionRequiredPanel.tsx`

When `action_reason_code === "NURTURE_SWITCH_RECOMMENDED"`:
- Show special action card with nurture icon
- Primary button: "Switch to Nurture"
- On click: Open dialog to select cadence (weekly/biweekly/monthly)

### 4.2 Nurture Cadence Selection Dialog
**File:** `src/components/dashboard/NurtureSwitchDialog.tsx` (new)

Modal dialog with:
- Explanation of nurture mode benefits
- Radio buttons for cadence selection (weekly, biweekly, monthly)
- Optional: Theme selection (industry updates, product tips, case studies)
- Confirm button that updates lead strategy and nurture_cadence

### 4.3 Lead Table Quick Switch
**File:** `src/components/dashboard/LeadTable.tsx`

Add inline strategy switching:
- Display current strategy badge (Fast/Nurture) in a new column
- Click to toggle or open cadence selector
- Show nurture cadence indicator if set

---

## 5. Re-engagement Recommendations

### 5.1 Update deriveAction for Better Re-engagement
**File:** `supabase/functions/gmail-sync/index.ts`

Enhance re-engagement logic:
- When suggesting "Re-engage cold lead", include context in action_instructions
- Provide suggested themes based on last interaction type
- Consider time of year for relevant hooks

### 5.2 Re-engagement Templates
**File:** `src/prompts/emailPrompts.ts`

Add new prompt for re-engagement emails:
```typescript
export const REENGAGE_EMAIL_PROMPT = `Write a re-engagement email for a lead who hasn't responded in ${DAYS} days.

Context: Last interaction was about ${LAST_TOPIC}.
Strategy: Provide value first, then soft CTA.

Suggested hooks:
- Industry news/update relevant to their business
- New feature or capability announcement
- Case study from similar company
- Seasonal/quarterly check-in
`;
```

---

## 6. Cadence-Based Reminders

### 6.1 Nurture Due Calculation Enhancement
**File:** `supabase/functions/gmail-sync/index.ts`

Update nurture campaign logic to work without requiring prior `nurture_outbound_count`:
- If lead is in nurture mode with cadence set, calculate next touch date
- If never sent nurture email, suggest first nurture touch after min_days_after_last_touch

### 6.2 Dashboard Reminder Integration
The existing `needs_action` + `eligible_at` system will surface nurture reminders automatically once the backend is updated.

---

## 7. Settings: Auto-Nurture Rules

### 7.1 New Signals Configuration UI
**File:** `src/components/settings/CadenceSettingsCard.tsx`

Add a new "Auto-Nurture Rules" section:
- Toggle: "Suggest nurture mode when no reply after X follow-ups"
- Input: Number of follow-ups before suggestion (default: 3)
- Toggle: "Automatically switch to nurture after breakup email"
- Dropdown: Default nurture cadence for auto-switches

### 7.2 Update cadence_settings Schema
**File:** `src/lib/cadenceSettingsTypes.ts`

Add to `Signals` interface:
```typescript
auto_nurture: {
  enabled: boolean;
  after_followup_count: number;
  auto_switch_after_breakup: boolean;
  default_cadence: "weekly" | "biweekly" | "monthly";
}
```

---

## Implementation Order

### Phase 1: Database & Backend
1. Add new columns to leads table (nurture_cadence, mode_changed_at, auto_nurture_eligible)
2. Update deriveAction to set auto_nurture_eligible flag
3. Add NURTURE_SWITCH_RECOMMENDED action reason code

### Phase 2: Dashboard UI
4. Add "Nurture Candidates" to IntelligenceCards
5. Create NurtureSwitchDialog component
6. Update ActionRequiredPanel to handle nurture switch actions
7. Add strategy column with inline switching to LeadTable

### Phase 3: Recommendations
8. Enhance AIRecommendation with nurture-specific suggestions
9. Add re-engagement email prompts
10. Update deriveAction re-engagement logic

### Phase 4: Settings
11. Add auto-nurture configuration to CadenceSettingsCard
12. Update cadence_settings schema with auto_nurture section

---

## Expected Behavior After Implementation

1. **Lead with no response after 3 follow-ups:**
   - Action Required panel shows "Switch to Nurture Mode" with special styling
   - Clicking opens cadence selection dialog
   - After selection, lead's strategy changes to "nurture" with the chosen cadence

2. **Lead in nurture mode:**
   - Dashboard shows when next nurture email is due based on cadence
   - AI recommendations suggest relevant nurture themes
   - Lead table shows "Nurture (Monthly)" badge

3. **Cold lead (45+ days):**
   - Re-engagement action appears in Action Required panel
   - Email composer pre-loads re-engagement template
   - Includes suggested hooks based on last interaction

4. **Dashboard intelligence:**
   - New "Nurture Candidates" card shows count of leads to consider
   - Stale leads and nurture candidates may overlap but serve different purposes
   - AI recommendations prioritize time-sensitive nurture actions
