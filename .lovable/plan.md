

# Fix: Nurture Leads Getting Wrong Playbook in Automation

## Root Cause

Two bugs in the `automation-executor` edge function cause nurture leads to receive outbound prospecting emails instead of nurture content:

1. **Wrong default task**: When `next_action_key` is null (common for nurture leads in review mode), the code defaults to `"send_pre_2_followup"` (an outbound prospecting task) instead of checking the lead's `motion` field to pick the right task.

2. **No post-send state update**: After successfully sending an email, the automation-executor never clears `needs_action` / `eligible_at` or schedules the next step, so the lead can be re-picked on the next poll cycle.

## Changes

### 1. Fix AI Task Resolution in `automation-executor` (Critical)

In `supabase/functions/automation-executor/index.ts`, replace the task-mapping block (lines 238-246) with motion-aware logic:

```text
Before:
  const actionKey = lead.next_action_key || "send_pre_2_followup";
  let aiTask = "pre_email_2_followup";

After:
  const actionKey = lead.next_action_key;
  let aiTask: string;

  if (actionKey) {
    // Derive from explicit action key
    if (actionKey.startsWith("send_pre_1")) aiTask = "pre_email_1_intro";
    else if (actionKey.startsWith("send_pre_2")) aiTask = "pre_email_2_followup";
    else if (actionKey.startsWith("send_pre_3")) aiTask = "pre_email_3_followup";
    else if (actionKey.startsWith("send_pre_4")) aiTask = "pre_email_4_breakup";
    else if (actionKey.startsWith("send_nurture")) aiTask = "nurture_email_single";
    else aiTask = "pre_email_2_followup"; // truly unknown key
  } else {
    // No action key -- infer from motion
    if (lead.motion === "nurture") {
      aiTask = "nurture_email_single";
    } else {
      aiTask = "pre_email_1_intro"; // first outbound if no key
    }
  }
```

### 2. Add Post-Send State Update (Critical)

After a successful send and interaction logging (after line 465), add logic to:
- Clear `needs_action = false` and `eligible_at = null` immediately
- For outbound sequences: schedule next step with the correct `eligible_at` based on cadence intervals
- For nurture leads: increment `nurture_outbound_count`, set `last_nurture_outbound_at`, and schedule next nurture step based on cadence (7/14/30 days)
- Update `last_outbound_at` and `last_activity_at` timestamps

```text
// Post-send state update
const postUpdate = {
  needs_action: false,
  eligible_at: null,
  last_outbound_at: new Date().toISOString(),
  last_activity_at: new Date().toISOString(),
};

if (aiTask === "nurture_email_single") {
  // Increment nurture count and schedule next
  const cadenceDays = lead.nurture_cadence === "weekly" ? 7
    : lead.nurture_cadence === "monthly" ? 30 : 14;
  const nextEligible = new Date(Date.now() + cadenceDays * 86400000);
  nextEligible.setHours(9, 30, 0, 0);
  const nextCount = (lead.nurture_outbound_count || 0) + 1;

  Object.assign(postUpdate, {
    nurture_outbound_count: nextCount,
    last_nurture_outbound_at: new Date().toISOString(),
    next_action_key: `send_nurture_${nextCount + 1}`,
    next_action_label: `Nurture email #${nextCount + 1}`,
    needs_action: true,
    eligible_at: nextEligible.toISOString(),
    action_reason_code: "NURTURE_DUE",
  });
} else if (isOutboundSequence(aiTask)) {
  // Schedule next outbound step
  const nextStep = getNextStep(aiTask);
  if (nextStep) {
    const nextEligible = new Date(Date.now() + 2 * 86400000);
    nextEligible.setHours(9, 30, 0, 0);
    Object.assign(postUpdate, {
      next_action_key: nextStep.key,
      next_action_label: nextStep.label,
      needs_action: true,
      eligible_at: nextEligible.toISOString(),
      action_reason_code: "FOLLOWUP_DUE",
    });
  }
}

await supabase.from("leads").update(postUpdate).eq("id", lead.id);
```

### 3. Add Motion Context to AI Payload

Pass the lead's motion to the `ai_task` call so the AI model generates content appropriate for the lead's current phase:

```text
payload: {
  lead_id: lead.id,
  lead_context: `Name: ...\nMotion: ${lead.motion}\n...`,
  motion: lead.motion,  // <-- add explicit motion field
}
```

## Files Modified

- `supabase/functions/automation-executor/index.ts` -- Fix task resolution + add post-send updates

## What This Prevents

- Nurture leads will always get `nurture_email_single` content, not outbound follow-ups
- Post-send state is properly updated so leads don't get double-sent
- Next nurture/outbound steps are correctly scheduled based on the lead's actual motion
