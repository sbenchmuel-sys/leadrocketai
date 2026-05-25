// ============================================
// CLIENT-SIDE CAMPAIGN TYPES
// Mirrors the server-side campaignTypes.ts for UI consumption.
// These types are used by CampaignSettingsPanel, BulkAutomationDialog,
// and any client component that needs campaign structure awareness.
// ============================================

import type { CanonicalChannel } from "@/lib/channels";

// ── Structured step config (client-side mirror) ─────────────────────

export type StepType = "intro" | "followup" | "value_add" | "breakup" | "nurture" | "re_engagement";

export interface CampaignStepConfig {
  step_type: StepType;
  channel: CanonicalChannel;
  objective: string;
  tone: string;
  max_word_count: number;
  cta_type: string;
  sequence_position: number;
  custom_instructions: string;
  active: boolean;
}

// ── Campaign settings (structured replacement for raw text) ─────────

export interface StructuredCampaignSettings {
  include_meeting_cta: boolean;
  global_instructions: string;
  steps: Record<string, CampaignStepConfig>;
}

// ── Legacy adapter ──────────────────────────────────────────────────
// Converts between the old CampaignSettings format (raw text) and
// the new structured format. This allows existing campaigns to work
// while new ones use the structured model.

export interface LegacyCampaignSettings {
  includeMeetingCTA: boolean;
  globalInstructions: string;
  stepInstructions: Record<string, string>;
}

/**
 * Convert legacy CampaignSettings to the raw action_instructions text format.
 * This is the ONLY place that serializes campaign settings into the text blob
 * stored in leads.action_instructions. Centralizing this prevents format drift.
 */
export function serializeCampaignInstructions(settings: LegacyCampaignSettings): string | null {
  const parts: string[] = [];

  // Global / campaign rules
  const globalRules: string[] = [];
  if (settings.includeMeetingCTA) {
    globalRules.push("- Always include a meeting booking CTA with the calendar link");
  }
  if (settings.globalInstructions.trim()) {
    globalRules.push(
      ...settings.globalInstructions
        .split("\n")
        .filter(Boolean)
        .map((l) => (l.startsWith("-") ? l : `- ${l}`))
    );
  }
  if (globalRules.length > 0) {
    parts.push(`CAMPAIGN RULES:\n${globalRules.join("\n")}`);
  }

  // Step-specific instructions
  for (const [step, text] of Object.entries(settings.stepInstructions)) {
    const trimmed = text.trim();
    if (trimmed) {
      parts.push(`STEP ${step} INSTRUCTIONS:\n${trimmed}`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Filter the raw action_instructions blob to only the rules and step
 * relevant to the email being generated. Without this, every step in a
 * campaign would receive instructions intended for all 4 steps and the
 * model has to guess which to apply (it generally guesses wrong).
 *
 * Returns the same text format the rest of the pipeline expects:
 * CAMPAIGN RULES + (only) STEP {stepNumber} INSTRUCTIONS.
 * Mirrors parseLegacyInstructions in supabase/functions/_shared/campaignResolver.ts.
 */
export function extractStepScopedInstructions(
  raw: string | null,
  stepNumber: number,
): string | null {
  if (!raw) return null;

  const lines = raw.split("\n");
  const globalLines: string[] = [];
  const stepLines: Record<number, string[]> = {};
  let currentBlock: number | null = null;

  for (const line of lines) {
    const stepMatch = line.match(/^STEP\s+(\d+)\s+INSTRUCTIONS\s*:/i);
    if (stepMatch) {
      currentBlock = parseInt(stepMatch[1], 10);
      stepLines[currentBlock] = [];
    } else if (currentBlock !== null) {
      stepLines[currentBlock].push(line);
    } else {
      globalLines.push(line);
    }
  }

  // No step markers at all → treat as plain text, return as-is.
  if (Object.keys(stepLines).length === 0) {
    return raw.trim() || null;
  }

  const parts: string[] = [];
  const globalText = globalLines.join("\n").trim();
  if (globalText) parts.push(globalText);

  const currentStepText = (stepLines[stepNumber] || []).join("\n").trim();
  if (currentStepText) {
    parts.push(`STEP ${stepNumber} INSTRUCTIONS:\n${currentStepText}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Parse raw action_instructions text back into the legacy settings shape.
 * Used when loading existing campaign data for editing.
 */
export function deserializeCampaignInstructions(raw: string | null): LegacyCampaignSettings {
  const result: LegacyCampaignSettings = {
    includeMeetingCTA: false,
    globalInstructions: "",
    stepInstructions: {},
  };

  if (!raw) return result;

  const lines = raw.split("\n");
  let currentBlock: string | null = null;
  const globalLines: string[] = [];

  for (const line of lines) {
    const stepMatch = line.match(/^STEP\s+(\d+)\s+INSTRUCTIONS\s*:/i);
    if (stepMatch) {
      currentBlock = stepMatch[1];
      result.stepInstructions[currentBlock] = "";
    } else if (currentBlock) {
      result.stepInstructions[currentBlock] = (result.stepInstructions[currentBlock] + "\n" + line).trim();
    } else {
      const cleaned = line.replace(/^CAMPAIGN\s+RULES\s*:\s*/i, "").trim();
      if (cleaned) {
        if (/always include a meeting booking cta/i.test(cleaned)) {
          result.includeMeetingCTA = true;
        } else {
          globalLines.push(cleaned.replace(/^-\s*/, ""));
        }
      }
    }
  }

  result.globalInstructions = globalLines.join("\n");
  return result;
}

// ── Step metadata for UI display ────────────────────────────────────

export const OUTBOUND_STEPS = [
  { key: "1", label: "Step 1 — Intro Email", type: "intro" as StepType },
  { key: "2", label: "Step 2 — Follow-up 1", type: "followup" as StepType },
  { key: "3", label: "Step 3 — Follow-up 2", type: "value_add" as StepType },
  { key: "4", label: "Step 4 — Breakup Email", type: "breakup" as StepType },
];

export const NURTURE_STEPS = [
  { key: "1", label: "Step 1 — First Nurture", type: "nurture" as StepType },
  { key: "2", label: "Step 2 — Second Nurture", type: "nurture" as StepType },
  { key: "3", label: "Step 3 — Third Nurture", type: "nurture" as StepType },
  { key: "4", label: "Step 4 — Fourth Nurture", type: "nurture" as StepType },
];
