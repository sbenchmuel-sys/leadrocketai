

## Simplify Cadence: Remove Strategy, Keep Motion-Based Intervals

### Overview
Replace the current dual-strategy model (`fast` / `nurture`) with a simpler motion-based interval system. Intervals are determined by the lead's **motion**, not a separate "strategy" field.

### New Motion Intervals

| Motion | Email Intervals |
|--------|----------------|
| Outbound | 0d, 2d, 4d, 7d |
| Inbound | 0d, 2d, 4d |
| Nurture | Weekly (7d), Biweekly (14d, default), Monthly (30d) |

### What Changes

**1. Cadence Settings Types** (`src/lib/cadenceSettingsTypes.ts`)
- Replace `modes: { fast: ModeSettings; nurture: ModeSettings }` with `motions: { outbound: MotionIntervals; inbound: MotionIntervals; nurture: NurtureIntervals }`
- New `MotionIntervals` interface: `{ email_intervals_days: number[] }`
- New `NurtureIntervals` interface: `{ cadences: { weekly: number; biweekly: number; monthly: number } }`
- Update `DEFAULT_CADENCE_SETTINGS` to use the new intervals: outbound `[0, 2, 4, 7]`, inbound `[0, 2, 4]`, nurture cadences `{ weekly: 7, biweekly: 14, monthly: 30 }`
- Remove `ModeSettings` interface (no longer needed)
- Remove `modes` from `CadenceSettingsV1`
- Keep `time_rules`, `guardrails`, `stop_pause_rules`, `whatsapp`, `flows`, `signals` unchanged

**2. Sequence Updater** (`src/lib/sequenceUpdater.ts`)
- Replace hardcoded `FAST_INTERVALS = [2, 3, 3, 4]` with motion-based lookup from the new defaults
- For outbound leads: use `[0, 2, 4, 7]` (intervals between steps, so step 1 at 0d, step 2 at 2d, step 3 at 4d, step 4 at 7d)
- For inbound leads: use `[0, 2, 4]`

**3. AutomationPreviewCard** (`src/components/lead/AutomationPreviewCard.tsx`)
- Replace `FAST_INTERVALS = [2, 3, 3, 4]` with motion-based intervals from defaults
- Determine intervals based on `lead.motion` instead of strategy
- Update step labels to match new interval count (4 steps for outbound, 3 for inbound)

**4. Dashboard Metrics** (`src/lib/dashboardMetricsService.ts`)
- Update `getNurtureReadyLeads` to stop checking `strategy === "fast"` -- instead check motion is `outbound_prospecting` or `inbound_response`

**5. Dashboard Utils** (`src/lib/dashboardUtils.ts`)
- Remove `strategy` from `SourcePreset` interface
- Remove `strategy` from all source preset entries
- Update `getNurtureCandidates` to stop checking `strategy === "fast"` -- check motion instead

**6. Lead Queries** (`src/lib/supabaseQueries.ts`)
- Remove `strategy` from `CreateLeadForm` interface (no longer a required field)
- Remove `strategy` from `createLead` payload
- Keep `strategy` in `LeadDetail` and `LeadListItem` select queries for backwards compatibility (old leads may still have it) but stop using it for logic

**7. Lead Detail Header** (`src/components/lead/LeadDetailHeader.tsx`)
- Remove `strategyLabel` display ("Fast Strategy" / "Nurture Strategy")
- Replace with motion-based label if needed, or simply remove

**8. Edit Lead Dialog** (`src/components/lead/EditLeadDialog.tsx`)
- Remove `strategy` field from the form schema and UI

**9. Settings Card** (`src/components/settings/CadenceSettingsCard.tsx`)
- Refactor from "Fast / Nurture" mode tabs to "Outbound / Inbound / Nurture" motion tabs
- Show the correct intervals for each motion
- Update visual sequence summary to reflect new step counts

**10. Prompt Files** (`src/prompts/emailPrompts.ts`, `src/prompts/intentRouter.ts`)
- Remove `suggested_strategy` from intent router output
- Update `getIntroEmailPrompt` to take motion instead of strategy

**11. LLM Output Schemas** (`src/schemas/llmOutputSchemas.ts`)
- Remove `suggested_strategy` field from the analysis schema

**12. Generate Draft** (`src/lib/generateDraft.ts`)
- Replace `Strategy: ${lead.strategy}` context line with `Motion: ${lead.motion}`

### What Does NOT Change
- The `strategy` column in the database is left alone (no migration needed, just ignored)
- Composer, sequence engine core, automation safety logic untouched
- WhatsApp cadence settings unchanged
- Time rules, guardrails, stop/pause rules unchanged

### Key Design Decisions
- Intervals are now **cumulative offsets from first send** (0d, 2d, 4d, 7d) rather than gaps between steps
- Nurture keeps its existing cadence profile system (weekly/biweekly/monthly)
- Strategy field becomes a no-op -- existing data preserved, just not read for logic

