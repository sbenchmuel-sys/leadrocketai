// Unified Draft Generator — single entry point for all email generation
import type { AITaskType } from "@/hooks/useAITask";
import type { Motion } from "@/lib/dashboardUtils";
import { contextResolver, type ResolvedContext } from "@/lib/contextResolver";
import { playbookResolver, type PlaybookRecommendation } from "@/lib/playbookResolver";
import { scoreAndSelectModel, type ComplexityResult, type AIModel } from "@/lib/complexityScorer";

// ============================================
// TYPES
// ============================================

export interface GenerateDraftInput {
  lead_id: string;
  channel?: "email" | "linkedin" | "whatsapp";
  override_intent?: AITaskType | null;
  instructions?: string | null;
  motion_override?: Motion | null;
}

export interface DraftPipelineResult {
  resolved_context: ResolvedContext;
  playbook: PlaybookRecommendation;
  recommended_intent: AITaskType;
  recommended_playbook: string;
  sequence_step: string;
  draft_text: string | null; // null until AI generates
  // Phase 2: complexity + model
  complexity_score: number;
  model_used: AIModel;
  scoring_factors: { label: string; points: number }[];
}

// ============================================
// MAIN ORCHESTRATOR
// ============================================

export async function generateDraft(input: GenerateDraftInput): Promise<DraftPipelineResult> {
  const { lead_id, channel = "email", override_intent, instructions, motion_override } = input;

  console.log("[generateDraft] Starting pipeline for lead", lead_id);

  // Step 1: Resolve context
  const resolvedContext = await contextResolver(lead_id);

  // Apply motion override if provided
  if (motion_override && motion_override !== resolvedContext.motion) {
    console.log("[generateDraft] Motion override:", resolvedContext.motion, "→", motion_override);
    (resolvedContext as any).motion = motion_override;
  }

  // Step 2: Determine playbook
  const playbook = playbookResolver(resolvedContext);

  // Step 3: Apply override intent if provided
  const finalIntent = override_intent || playbook.recommended_intent;

  // Step 4: Complexity scoring + model selection
  const complexity = scoreAndSelectModel(resolvedContext, finalIntent, channel, instructions);

  const result: DraftPipelineResult = {
    resolved_context: resolvedContext,
    playbook,
    recommended_intent: finalIntent,
    recommended_playbook: playbook.recommended_playbook,
    sequence_step: playbook.next_sequence_step,
    draft_text: null,
    complexity_score: complexity.complexity_score,
    model_used: complexity.model_used,
    scoring_factors: complexity.scoring_factors,
  };

  console.log("[generateDraft] Recommended:", {
    intent: playbook.recommended_intent,
    playbook: playbook.recommended_playbook,
    step: playbook.next_sequence_step,
    finalIntent: override_intent ? `${finalIntent} (override)` : finalIntent,
  });

  console.log("[generateDraft] Complexity:", {
    score: complexity.complexity_score,
    model: complexity.model_used,
    factors: complexity.scoring_factors.map(f => `${f.label} (+${f.points})`).join(", "),
  });

  return result;
}
