// ============================================================================
// CAMPAIGN COLLATERAL ORCHESTRATOR (Outreach Unit D)
//
// Generates AI-drafted, rep-editable collateral (industry one-pagers, technical
// walkthroughs) for a campaign, grounded in the campaign's own instructions +
// uploaded knowledge document. ALL generation routes through ai_task (no new AI
// caller); the ai_task collateral path is CAMPAIGN-LEVEL (no step_number) and is
// reachable only via the collateral_* task allowlist.
//
// RETENTION GUARD: collateral is built ONLY from the seller's own instructions +
// KB document. We never pass customer email/message bodies into the payload, so
// nothing that persists in campaign_collateral can carry purge-protected content.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";
import {
  upsertCollateral,
  type CampaignWithSteps,
  type CollateralType,
} from "@/lib/campaignQueries";

export const COLLATERAL_TYPES: { type: CollateralType; label: string; blurb: string }[] = [
  { type: "one_pager", label: "One-pager", blurb: "A one-page overview to share with a prospect." },
  { type: "walkthrough", label: "Technical walkthrough", blurb: "A plain-language how-it-works explainer." },
];

export function collateralLabel(type: CollateralType): string {
  return COLLATERAL_TYPES.find((t) => t.type === type)?.label ?? type;
}

function taskForType(type: CollateralType): string {
  return type === "one_pager" ? "collateral_one_pager" : "collateral_walkthrough";
}

function buildAudience(industry: string | null): string {
  return industry
    ? `Audience: prospects in the ${industry} industry.`
    : "Audience: prospects across industries (general).";
}

function collateralInstructions(type: CollateralType, industry: string | null): string {
  const what = type === "one_pager" ? "a one-page overview" : "a technical walkthrough";
  const tailor = industry ? ` Tailor it to the ${industry} industry.` : "";
  return (
    `Write ${what} as a reusable, shareable draft.` +
    tailor +
    " Ground it strictly in the seller's provided materials and campaign instructions — do not invent claims, and do not reference any specific prospect's emails or messages."
  );
}

function defaultTitle(type: CollateralType, industry: string | null): string {
  const base = collateralLabel(type);
  return industry ? `${base} — ${industry}` : base;
}

export interface CollateralGenError extends Error {
  retriable: true;
}

async function callAiTask(task: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase.functions.invoke("ai_task", { body: { task, payload } });
  if (error) {
    const e = new Error(error.message || "Generation failed") as CollateralGenError;
    e.retriable = true;
    throw e;
  }
  if (!data?.ok || typeof data?.content !== "string" || !data.content.trim()) {
    const e = new Error((data && data.error) || "The AI returned no content — try again.") as CollateralGenError;
    e.retriable = true;
    throw e;
  }
  return data.content.trim();
}

/**
 * Generate (or regenerate) one collateral draft and persist it. Overwrites any
 * existing row for (campaign × type × variant) — callers MUST confirm first when
 * the existing row is rep-edited (edits are sacred; see the UI's confirm guard).
 */
export async function generateCollateral(
  campaign: CampaignWithSteps,
  type: CollateralType,
  variant: string | null,
): Promise<void> {
  const content = await callAiTask(taskForType(type), {
    campaign_id: campaign.id,
    industry: variant || undefined,
    motion: campaign.motion,
    lead_context: buildAudience(variant),
    offer_summary: campaign.global_instructions || "",
    custom_instructions: collateralInstructions(type, variant),
  });

  await upsertCollateral(campaign.id, type, variant, {
    title: defaultTitle(type, variant),
    body: content,
    is_edited: false,
  });
}
