// ============================================================================
// AUTHORING-TIME CAMPAIGN INSTRUCTION RESOLVER (Unit B Phase 2)
//
// Server-side glue used ONLY by ai_task's gated campaign-authoring branch. It
// turns (campaign_id, step_number, optional industry) into a ready-to-inject
// `campaign_instruction` prompt block, reusing the canonical pieces:
//
//   loadCampaignById  (status-agnostic authoring loader — a draft IS the point)
//     → resolveCampaignInstruction (the one true resolver, structured path)
//     → formatInstructionForPrompt (the prompt block ai_task already injects)
//
// It ALSO returns the campaign's knowledge_document_id so the caller can scope
// KB retrieval to that one uploaded file, and the resolved channel/variant.
//
// WORKSPACE ISOLATION (load-bearing): this runs with a service-role client, so
// it MUST verify the requesting user is a member of the campaign's workspace
// before returning anything. A rep passing someone else's campaign_id gets null
// (fail closed) — never another workspace's instructions or KB document id.
//
// This is AUTHORING ONLY. The live send path resolves campaigns per-lead via
// loadCampaignForLead (active-only) and is untouched by this module.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadCampaignById } from "./campaignStepLoader.ts";
import type { LoadedCampaign, StructuredCampaignStep } from "./campaignStepConfig.ts";
import { resolveCampaignInstruction, formatInstructionForPrompt } from "./campaignResolver.ts";
import type { CanonicalChannel } from "./campaignTypes.ts";

type ServiceClient = ReturnType<typeof createClient>;

export interface CampaignAuthoringInstruction {
  /** Formatted block to inject as enhancedPayload.campaign_instruction. */
  promptBlock: string;
  /**
   * kb_chunks.document_id to scope KB retrieval to (null = whole owner KB).
   * Only set when the document's owner is verified to be a member of THIS
   * workspace — the column is member-writable, so a crafted value pointing at
   * another tenant's document is rejected here and returned as null.
   */
  knowledgeDocumentId: string | null;
  /**
   * owner_user_id of the (validated) knowledge document — the safe KB owner the
   * caller should query as so any workspace member retrieves the shared
   * collateral. Null when there is no trusted document.
   */
  knowledgeDocOwnerId: string | null;
  /** Resolved channel for this step (email / voice / sms / ...). */
  channel: CanonicalChannel;
  /** The variant_group actually selected (industry label, or null = General). */
  variantGroup: string | null;
}

// ── Variant selection ───────────────────────────────────────────────────────
// For each step_number, pick the step row whose variant_group matches the lead
// industry (case-insensitive); fall back to the General/NULL row; finally to
// whatever row exists for that number. Returns a LoadedCampaign holding exactly
// one step per step_number so getStructuredStepConfig resolves unambiguously.
function selectVariant(campaign: LoadedCampaign, industry: string | null): LoadedCampaign {
  const target = industry?.trim().toLowerCase() || null;
  const byNumber = new Map<number, StructuredCampaignStep[]>();
  for (const s of campaign.steps) {
    const list = byNumber.get(s.step_number) ?? [];
    list.push(s);
    byNumber.set(s.step_number, list);
  }

  const chosen: StructuredCampaignStep[] = [];
  for (const [, candidates] of byNumber) {
    const isGeneral = (s: StructuredCampaignStep) =>
      s.variant_group == null || s.variant_group.trim() === "";
    const industryMatch = target
      ? candidates.find((s) => (s.variant_group ?? "").trim().toLowerCase() === target)
      : undefined;
    const pick = industryMatch ?? candidates.find(isGeneral) ?? candidates[0];
    if (pick) chosen.push(pick);
  }

  chosen.sort((a, b) => a.step_number - b.step_number);
  return { ...campaign, steps: chosen };
}

// ── Workspace membership gate ───────────────────────────────────────────────
async function userIsWorkspaceMember(
  client: ServiceClient,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  // Service-role internal callers (no real end-user identity) are trusted infra.
  if (!userId || userId === "service-role") return true;
  const { data, error } = await client
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[aiCampaignResolver] membership check failed:", error);
    return false; // fail closed
  }
  return !!data;
}

// Campaign-LEVEL instruction block (no specific step) — used by collateral
// generation (Unit D). It carries the campaign's own global instructions and
// motion, with no per-step framework. Mirrors the formatting envelope of
// formatInstructionForPrompt so ai_task injects it the same way.
function formatCampaignLevelInstruction(campaign: LoadedCampaign): string {
  const parts: string[] = ["=== CAMPAIGN INSTRUCTION (CAMPAIGN-LEVEL) ==="];
  parts.push(`Motion: ${campaign.motion || "outbound_prospecting"}`);
  if (campaign.global_instructions) {
    parts.push("\nCAMPAIGN CUSTOM INSTRUCTIONS (user-provided, MANDATORY):");
    parts.push(campaign.global_instructions);
  }
  parts.push("=== END CAMPAIGN INSTRUCTION ===");
  return parts.join("\n");
}

/**
 * Build the authoring-time campaign instruction.
 *
 * stepNumber:
 *   • a number → per-touch authoring (Unit B): resolves the structured step's
 *     framework/objective/hard-rules for that touch. UNCHANGED behavior.
 *   • null → campaign-LEVEL authoring (Unit D collateral): no specific step;
 *     returns the campaign's global instructions. The ai_task gate only passes
 *     null for the collateral_* task allowlist, never for the live send path.
 *
 * Both paths share the SAME fail-closed workspace-membership gate and the SAME
 * knowledge-document validation. Returns null (fail closed) when the campaign is
 * missing, the user is not a member of its workspace, or (per-step) the
 * requested step doesn't exist.
 */
export async function resolveCampaignAuthoringInstruction(
  client: ServiceClient,
  campaignId: string,
  stepNumber: number | null,
  industry: string | null,
  requestingUserId: string,
): Promise<CampaignAuthoringInstruction | null> {
  // Workspace_id + knowledge_document_id are not part of loadCampaignById's
  // column set, so fetch them (and gate on membership) here first.
  const { data: meta } = await client
    .from("campaigns")
    .select("workspace_id, knowledge_document_id")
    .eq("id", campaignId)
    .maybeSingle();
  const workspaceId = (meta as { workspace_id?: string } | null)?.workspace_id;
  if (!workspaceId) return null;

  // Fail-closed workspace-membership gate — identical for per-step and
  // campaign-level. A rep can only author against their own workspace's campaign.
  if (!(await userIsWorkspaceMember(client, workspaceId, requestingUserId))) {
    console.warn(
      `[aiCampaignResolver] user ${requestingUserId} is not a member of workspace ${workspaceId} — refusing campaign ${campaignId}`,
    );
    return null;
  }

  const campaign = await loadCampaignById(campaignId, client);
  if (!campaign) return null;

  // Validate the campaign's knowledge document before trusting it to scope KB
  // retrieval (shared by both paths). knowledge_document_id is member-writable,
  // so confirm the chunks' owner is a member of THIS workspace; otherwise ignore
  // it (fail closed) so a crafted id can't surface another tenant's KB.
  let knowledgeDocumentId =
    (meta as { knowledge_document_id?: string | null } | null)?.knowledge_document_id ?? null;
  let knowledgeDocOwnerId: string | null = null;
  if (knowledgeDocumentId) {
    const { data: docChunk } = await client
      .from("kb_chunks")
      .select("owner_user_id")
      .eq("document_id", knowledgeDocumentId)
      .limit(1)
      .maybeSingle();
    const ownerId = (docChunk as { owner_user_id?: string } | null)?.owner_user_id ?? null;
    if (ownerId && (await userIsWorkspaceMember(client, workspaceId, ownerId))) {
      knowledgeDocOwnerId = ownerId;
    } else {
      console.warn(
        `[aiCampaignResolver] knowledge_document_id ${knowledgeDocumentId} on campaign ${campaignId} is not owned by a member of workspace ${workspaceId} — ignoring it`,
      );
      knowledgeDocumentId = null; // fail closed — do not scope to a foreign document
    }
  }

  // ── Campaign-level path (collateral) ──────────────────────────────────────
  if (stepNumber == null) {
    return {
      promptBlock: formatCampaignLevelInstruction(campaign),
      knowledgeDocumentId,
      knowledgeDocOwnerId,
      channel: (campaign.default_channel || "email") as CanonicalChannel,
      variantGroup: industry?.trim() ? industry.trim() : null,
    };
  }

  // ── Per-step path (Unit B) — unchanged ────────────────────────────────────
  const selected = selectVariant(campaign, industry);
  const targetStep = selected.steps.find((s) => s.step_number === stepNumber && s.active);
  if (!targetStep) return null;

  const instruction = resolveCampaignInstruction({
    lead_id: "authoring",
    // Synthetic key: resolveStepNumber extracts the digits and clamps to the
    // campaign's active-step count (up to 9 for structured campaigns).
    action_key: `campaign_step_${stepNumber}`,
    motion: campaign.motion || "outbound_prospecting",
    channel: (targetStep.channel || campaign.default_channel) as CanonicalChannel,
    structured_campaign: selected,
    include_meeting_cta: campaign.include_meeting_cta,
  });

  return {
    promptBlock: formatInstructionForPrompt(instruction),
    knowledgeDocumentId,
    knowledgeDocOwnerId,
    channel: instruction.channel,
    variantGroup: targetStep.variant_group ?? null,
  };
}
