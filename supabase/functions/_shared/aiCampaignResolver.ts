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
import { resolveCampaignInstruction, formatInstructionForPrompt, meetingLinkForDraft } from "./campaignResolver.ts";
import type { CanonicalChannel } from "./campaignTypes.ts";
import { isWorkspaceMember, validateCampaignKnowledgeDoc } from "./campaignKnowledgeDoc.ts";

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
  /**
   * The booking link to thread into THIS touch's preview draft, or null when the
   * step's meeting CTA is off / the channel isn't email / the rep has no
   * calendar_link. This is the REQUESTING rep's OWN rep_profiles.calendar_link
   * (per-rep, fail-closed — never another rep's). The caller sets it as
   * enhancedPayload.meeting_link so the authoring preview makes the SAME per-step
   * CTA decision the live send will. Always null for campaign-level (collateral).
   */
  meetingLink: string | null;
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

// Workspace membership gate + knowledge-document validation now live in the
// shared _shared/campaignKnowledgeDoc.ts (isWorkspaceMember / validateCampaignKnowledgeDoc)
// so the authoring path and the live send path use ONE fail-closed implementation.

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
  if (!(await isWorkspaceMember(client, workspaceId, requestingUserId))) {
    console.warn(
      `[aiCampaignResolver] user ${requestingUserId} is not a member of workspace ${workspaceId} — refusing campaign ${campaignId}`,
    );
    return null;
  }

  const campaign = await loadCampaignById(campaignId, client);
  if (!campaign) return null;

  // The requesting rep's OWN booking link (per-rep, fail-closed) — loaded by
  // user_id so a rep can never preview another rep's link. Best-effort: a missing
  // profile or empty link resolves to null → the meeting CTA is omitted cleanly
  // (no placeholder, no broken link). Threaded into the preview only when this
  // step's decision is on (mirrors the live send).
  const { data: repProfile } = await client
    .from("rep_profiles")
    .select("calendar_link")
    .eq("user_id", requestingUserId)
    .maybeSingle();
  const repCalendarLink =
    (repProfile as { calendar_link?: string | null } | null)?.calendar_link?.trim() || null;

  // Validate the campaign's knowledge document before trusting it to scope KB
  // retrieval, via the shared fail-closed helper (same code the live send path
  // uses). knowledge_document_id is member-writable, so a crafted id pointing at
  // another tenant's document is rejected here and returned as null.
  const storedDocId =
    (meta as { knowledge_document_id?: string | null } | null)?.knowledge_document_id ?? null;
  const validatedDoc = await validateCampaignKnowledgeDoc(client, workspaceId, storedDocId);
  const knowledgeDocumentId = validatedDoc?.documentId ?? null;
  const knowledgeDocOwnerId = validatedDoc?.ownerId ?? null;

  // ── Campaign-level path (collateral) ──────────────────────────────────────
  if (stepNumber == null) {
    return {
      promptBlock: formatCampaignLevelInstruction(campaign),
      knowledgeDocumentId,
      knowledgeDocOwnerId,
      channel: (campaign.default_channel || "email") as CanonicalChannel,
      variantGroup: industry?.trim() ? industry.trim() : null,
      // Campaign-level (collateral) generation is not a per-step email touch.
      meetingLink: null,
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
    calendar_link: repCalendarLink,
  });

  // Thread the rep's own link into the preview exactly when the live send would —
  // via the SAME shared helper the send path uses, so PREVIEW and SEND always
  // agree on the per-step CTA. Only ever returns the link we passed in (this rep's).
  const meetingLink = meetingLinkForDraft(instruction, repCalendarLink);

  return {
    promptBlock: formatInstructionForPrompt(instruction),
    knowledgeDocumentId,
    knowledgeDocOwnerId,
    channel: instruction.channel,
    variantGroup: targetStep.variant_group ?? null,
    meetingLink,
  };
}
