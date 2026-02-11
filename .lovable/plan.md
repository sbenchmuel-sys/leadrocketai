
# Update Settings: Add WhatsApp Cadence + Channel-Aware Sequence Display

## Overview
The current Cadence Settings card only shows email-specific sequence configuration. We need to update it to reflect the new dual-channel architecture (Email + WhatsApp) with their distinct cadence models for Outbound, Inbound, and Nurture flows.

## Changes

### 1. Update Types (`src/lib/cadenceSettingsTypes.ts`)

Add a new `WhatsAppCadenceSettings` interface and include it in `CadenceSettingsV1`:

```
WhatsAppCadenceSettings {
  outbound_followups_hours: number[];  // [24, 48, 72] then pause
  nurture_cadence_days: number[];      // [7, 14] (light touches)
  post_meeting_hours: number[];        // [4, 48] (reminder, check-in)
  max_messages_before_pause: number;   // default: 3
  automation_enabled: boolean;         // default: false (manual only)
}
```

Add defaults:
- `outbound_followups_hours: [24, 48, 72]`
- `nurture_cadence_days: [7, 14]`
- `post_meeting_hours: [4, 48]`
- `max_messages_before_pause: 3`
- `automation_enabled: false`

### 2. Redesign Modes Tab in CadenceSettingsCard (`src/components/settings/CadenceSettingsCard.tsx`)

**Current**: Single "Fast / Nurture" toggle showing one mode's email settings at a time.

**New**: A two-level structure:
1. Keep the Fast / Nurture mode toggle at the top
2. Below it, add a channel sub-section showing **Email** and **WhatsApp** side by side (or as sub-tabs)

For each mode (Fast/Nurture), display:

**Email Channel Section:**
- Reply Alert After (hours) -- existing
- Follow-up Sequence (days) -- existing chips: [2,3,3,4] for Fast, [5,7,7,10] for Nurture
- Breakup Trigger -- existing
- Post-Meeting settings -- existing

**WhatsApp Channel Section (new):**
- Follow-up Intervals (hours) -- chip input: [24, 48, 72]
- Max messages before pause -- number input (default 3)
- Post-Meeting nudge timing (hours) -- chip input: [4, 48]
- Nurture touch intervals (days) -- chip input: [7, 14] (only shown in Nurture mode)
- Automation enabled toggle -- Switch (default off, with helper text "WhatsApp is manual-only for now")

### 3. Add Visual Sequence Summary

At the top of the Modes tab, add a compact read-only summary showing the active sequences:

```
Outbound (Fast):
  Email:    Intro -> 2d -> FU1 -> 3d -> FU2 -> 3d -> FU3 -> 4d -> Breakup
  WhatsApp: Intro -> 24h -> Follow-up -> 48h -> Nudge -> Pause

Nurture:
  Email:    Insight -> 5d -> Case Study -> 7d -> Resource -> 7d -> ...
  WhatsApp: Short Insight -> 7d -> Soft Reconnect -> Pause
```

This is a simple text/badge display, not editable -- just for clarity.

### 4. Update Settings Page Accordion Label

In `src/pages/Settings.tsx`, rename the accordion item from "Email Cadence Settings" to "Sequence & Cadence Settings" to reflect that it now covers both channels.

## Technical Details

### Files Modified

1. **`src/lib/cadenceSettingsTypes.ts`**
   - Add `WhatsAppCadenceSettings` interface
   - Add `whatsapp` field to `CadenceSettingsV1` type
   - Add WhatsApp defaults to `DEFAULT_CADENCE_SETTINGS`

2. **`src/components/settings/CadenceSettingsCard.tsx`**
   - Add WhatsApp section inside the Modes tab beneath the existing email fields
   - Add helper functions: `updateWhatsAppSetting()` for state updates
   - Add `HourSequenceInput` usage for WhatsApp follow-up intervals
   - Add a compact sequence summary component at top of Modes tab
   - Update card title from "Email Cadence Settings" to "Sequence & Cadence Settings"

3. **`src/pages/Settings.tsx`**
   - Update accordion title and description for the cadence section
   - Change icon or label to reflect multi-channel scope

4. **`src/lib/workspaceProfileQueries.ts`** (if needed)
   - Ensure `getCadenceSettings` and `updateCadenceSettings` handle the new `whatsapp` field via deep merge with defaults (backward compatible)
