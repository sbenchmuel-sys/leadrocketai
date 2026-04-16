import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Import from shared modules
import { SYSTEM_GLOBAL_PROMPT, PROMPTS, QUALITY_SCORER_PROMPT, CLASSIFY_MESSAGE_PROMPT, GROUNDING_VALIDATOR_PROMPT } from "../_shared/prompts.ts";
import {
  CHANNEL_FRAMEWORKS, CHANNEL_FRAMEWORK_EXEMPT_TASKS,
  resolveSequenceStep, getSequenceFramework, resolveChannel, getChannelFramework,
  COLD_OUTREACH_STYLE_BLOCK, getColdOutreachBlock, REPLY_PATTERNS_BLOCK, BREAKUP_CLOSERS,
  type EmailFramework, selectEmailFramework, getEmailFrameworkBlock,
  buildMotionBlock, buildStyleModifier, buildToneBlock,
} from "../_shared/frameworks.ts";
import {
  classifyCommercialIntent, formatDecisionBlock, adjustOfferScore,
  buildDedupeContext, checkOfferDedupe,
  type ClassifiedDecision, type DedupeContext,
} from "../_shared/intentClassifier.ts";
import {
  resolveStagePolicy, formatStagePolicyBlock, adjustOfferScoreByStage,
  type ResolvedPolicy,
} from "../_shared/stagePolicy.ts";
import {
  selectReplyObjective, selectReplyObjectiveWithContinuity,
  formatObjectiveBlock, applyObjectiveOverrides,
  type ReplyObjectiveResult, type ContinuityObjectiveInfluence,
} from "../_shared/replyObjective.ts";
import {
  evaluateReply, buildEvaluatorFeedback,
  type ReplyEvaluation,
} from "../_shared/replyEvaluator.ts";
import {
  loadDealMemory, saveDealMemory, updateFromInbound, updateFromOutbound,
  computeMomentum, formatDealMemoryBlock, getContinuityHints,
  reconcileObjections,
  type DealMemory, type ContinuityHints,
} from "../_shared/dealMemory.ts";
import {
  adjustOfferScoreByContinuity, adjustStagePolicyByMomentum,
  type ContinuityScoreAdjustment,
} from "../_shared/continuityScoring.ts";

// ============================================
// STRIP LEAKED REASONING FROM LLM OUTPUT
// ============================================

/**
 * Robustly removes any internal reasoning/reflection/analysis blocks
 * that the LLM may have leaked before the actual email content.
 * Handles cases where the greeting is a name (e.g. "Eldad,") not just "Hi/Hey/Dear".
 */
function stripLeakedReasoning(text: string): string {
  if (!text) return text;

  // 1. Remove any block that starts with a reasoning header
  //    Match: INTERNAL REASONING:, INTERNAL REFLECTION:, INTERNAL ANALYSIS:
  //    These can appear at the start or after whitespace
  const reasoningHeaderPattern = /(?:^|\n)\s*(?:INTERNAL\s+REASONING|INTERNAL\s+REFLECTION|INTERNAL\s+ANALYSIS)\s*:?\s*\n/i;
  
  if (reasoningHeaderPattern.test(text)) {
    // Strategy: find the email body by looking for a greeting pattern
    // Greetings: Hi X, Hey X, Hello X, Dear X, Thanks X, Subject:, or just "Name,"
    // The email body typically starts after a double newline following reasoning
    
    // Try to find a standard greeting after reasoning
    const greetingPatterns = [
      // Standard greetings
      /\n((?:Hi|Hey|Hello|Dear|Thanks|Thank you|Subject:)\s*[^\n]*)/i,
      // Name-comma pattern (e.g., "Eldad," or "Shai,") — must be a short line
      /\n([A-Z][a-z]{1,20},\s*\n)/,
      // Fallback: find the last double-newline and take everything after
    ];

    for (const pattern of greetingPatterns) {
      const match = text.match(pattern);
      if (match && match.index !== undefined) {
        // Verify this isn't inside the reasoning (must be after significant text)
        const beforeMatch = text.substring(0, match.index);
        // Only strip if there's substantial reasoning before (>200 chars)
        if (beforeMatch.length > 200) {
          text = text.substring(match.index).trim();
          return text;
        }
      }
    }
    
    // Fallback: split on the last occurrence of double newline before short line
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      // Look for a greeting-like line
      if (/^(?:Hi|Hey|Hello|Dear|Thanks|Subject:)\b/i.test(line) ||
          /^[A-Z][a-z]{1,20},\s*$/.test(line)) {
        // Check there's reasoning before this
        const beforeLines = lines.slice(0, i).join('\n');
        if (beforeLines.length > 200 && reasoningHeaderPattern.test(beforeLines)) {
          text = lines.slice(i).join('\n').trim();
          return text;
        }
      }
    }
  }

  // 2. Also strip extended chain-of-thought blocks without explicit headers
  //    Look for patterns like "Let me...", "Okay, I need to...", "Let's re-evaluate..."
  //    followed eventually by a greeting
  const cotPattern = /^[\s\S]*?(?:(?:KB Insight|Constraint Check|Final plan|Let me|Okay,|Let's|I will|I need to|Looking at|Given the|The goal|Since the)[^\n]*\n)+[\s\S]*?\n\n/im;
  const cotMatch = text.match(cotPattern);
  if (cotMatch && cotMatch[0].length > 200) {
    const remainder = text.substring(cotMatch[0].length).trim();
    // Verify remainder looks like an email (starts with greeting or name)
    if (/^(?:Hi|Hey|Hello|Dear|Thanks|Subject:|[A-Z][a-z]{1,20},)/i.test(remainder)) {
      return remainder;
    }
  }

  return text.trim();
}

// ============================================
// MESSAGE DIVERSITY CONTROL
// ============================================

const OPENING_TYPES = ["observation", "problem", "trigger_event", "compliment", "direct_offer", "question", "followup_reference", "breakup"] as const;
const CTA_TYPES = ["quick_question", "soft_offer", "meeting_request", "permission_based", "timing_check", "breakup_close"] as const;

const OUTREACH_TASKS = new Set([
  "email_intro_fast", "email_intro_nurture", "pre_email_1_intro", "pre_email_2_followup",
  "pre_email_3_followup", "pre_email_4_breakup", "inbound_intro", "re_engagement_intro",
  "nurture_email_single", "post_meeting_followup_email", "reply_to_thread",
  "whatsapp_message", "linkedin_connect", "linkedin_followup",
]);

interface DiversityConstraints {
  avoid_opening_types: string[];
  avoid_angles: string[];
  avoid_cta_types: string[];
  preferred_angles: string[];
  preferred_cta_types: string[];
}

async function buildDiversityConstraints(
  adminClient: ReturnType<typeof createClient>,
  leadId: string,
  workspaceId: string | null,
  campaignId: string | null,
): Promise<DiversityConstraints> {
  const constraints: DiversityConstraints = {
    avoid_opening_types: [], avoid_angles: [], avoid_cta_types: [],
    preferred_angles: [], preferred_cta_types: [],
  };

  try {
    const { data: leadMessages } = await adminClient
      .from("message_generation_log")
      .select("opening_type, primary_angle, cta_type, sequence_step, channel")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(8);

    if (leadMessages && leadMessages.length > 0) {
      const recentOpenings = leadMessages.slice(0, 3).map((m: any) => m.opening_type).filter(Boolean);
      const recentAngles = leadMessages.map((m: any) => m.primary_angle).filter(Boolean);
      const recentCtas = leadMessages.slice(0, 2).map((m: any) => m.cta_type).filter(Boolean);

      constraints.avoid_opening_types = [...new Set(recentOpenings)];
      constraints.avoid_cta_types = [...new Set(recentCtas)];

      const angleCounts = new Map<string, number>();
      for (const angle of recentAngles) {
        angleCounts.set(angle, (angleCounts.get(angle) || 0) + 1);
      }
      for (const [angle, count] of angleCounts) {
        if (count >= 2) constraints.avoid_angles.push(angle);
      }
    }

    if (workspaceId) {
      const { data: campaignMessages } = await adminClient
        .from("message_generation_log")
        .select("opening_type, cta_type")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (campaignMessages && campaignMessages.length >= 5) {
        const usedOpenings = new Set(campaignMessages.map((m: any) => m.opening_type).filter(Boolean));
        const usedCtas = new Set(campaignMessages.map((m: any) => m.cta_type).filter(Boolean));

        for (const ot of OPENING_TYPES) {
          if (!usedOpenings.has(ot) && !constraints.avoid_opening_types.includes(ot)) {
            constraints.preferred_angles.push(ot);
          }
        }
        for (const ct of CTA_TYPES) {
          if (!usedCtas.has(ct) && !constraints.avoid_cta_types.includes(ct)) {
            constraints.preferred_cta_types.push(ct);
          }
        }
      }
    }

    console.log(`[ai_task] Diversity constraints: avoid_openings=[${constraints.avoid_opening_types}], avoid_angles=[${constraints.avoid_angles.slice(0,3)}], avoid_ctas=[${constraints.avoid_cta_types}]`);
  } catch (err) {
    console.error("[ai_task] Diversity constraint build failed:", err);
  }

  return constraints;
}

function formatDiversityBlock(constraints: DiversityConstraints, isOfferRouted: boolean): string {
  const parts: string[] = [];
  parts.push("=== MESSAGE DIVERSITY CONSTRAINTS ===");
  parts.push("To ensure fresh, varied outreach, follow these constraints:");
  if (constraints.avoid_opening_types.length > 0) parts.push(`- DO NOT use these opening styles (recently used): ${constraints.avoid_opening_types.join(", ")}`);
  if (constraints.avoid_angles.length > 0) parts.push(`- DO NOT use these angles/themes (overused): ${constraints.avoid_angles.join(", ")}`);
  // For OFFER_ROUTED_TASKS, CTA avoidance is handled by deal_memory (stateful),
  // so diversity constraints only apply to cold outreach tasks.
  if (!isOfferRouted && constraints.avoid_cta_types.length > 0) {
    parts.push(`- DO NOT use these CTA types (recently used): ${constraints.avoid_cta_types.join(", ")}`);
  }
  if (!isOfferRouted && constraints.preferred_cta_types.length > 0) {
    parts.push(`- PREFER one of these fresh CTA styles: ${constraints.preferred_cta_types.slice(0, 3).join(", ")}`);
  }
  parts.push("- Maintain brand voice consistency while varying approach");
  parts.push("- Quality and relevance always take priority over forced variation");
  return parts.join("\n");
}

function textSimilarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const words = s.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
    const bg = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) bg.add(`${words[i]} ${words[i+1]}`);
    return bg;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const bg of setA) { if (setB.has(bg)) intersection++; }
  return intersection / (setA.size + setB.size - intersection);
}

// ============================================
// LEAD CONTEXT BLOCK BUILDER (import/manual prior knowledge)
// ============================================

/** Priority order for lead context categories in prompt assembly.
 * Lower index = higher priority. This is NOT a char cap — it's structural ordering.
 * Cautions and prior relationships always come first. */
const LEAD_CONTEXT_CATEGORY_PRIORITY: string[] = [
  "caution",                // do-not-say / do-not-mention — ALWAYS first
  "relationship_history",   // prior contact, prior rep
  "commercial_signal",      // products owned, budget, competitor intel
  "historical_fact",        // factual data from known columns
  "imported_note",          // ambiguous free-text notes
  "inferred_hypothesis",    // AI-derived (lower confidence)
];

function buildLeadContextBlock(items: Array<{
  category: string; content_type: string; content_text: string;
  confidence: number | null; author_name: string | null; source_type: string;
}>): string {
  if (!items || items.length === 0) return "";

  // Sort by priority order
  const sorted = [...items].sort((a, b) => {
    const aIdx = LEAD_CONTEXT_CATEGORY_PRIORITY.indexOf(a.category);
    const bIdx = LEAD_CONTEXT_CATEGORY_PRIORITY.indexOf(b.category);
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });

  // Group by category
  const groups = new Map<string, string[]>();
  for (const item of sorted) {
    const key = item.category;
    if (!groups.has(key)) groups.set(key, []);
    const prefix = item.confidence != null ? `[confidence: ${(item.confidence * 100).toFixed(0)}%] ` : "";
    const authorSuffix = item.author_name ? ` (source: ${item.author_name})` : "";
    groups.get(key)!.push(`- ${prefix}${item.content_text}${authorSuffix}`);
  }

  const CATEGORY_LABELS: Record<string, string> = {
    caution: "CAUTIONS (DO NOT violate these)",
    relationship_history: "PRIOR RELATIONSHIP (do NOT sound like a cold intro if this exists)",
    commercial_signal: "COMMERCIAL CONTEXT (products owned, competitors, budget)",
    historical_fact: "KNOWN FACTS",
    imported_note: "IMPORTED NOTES (treat as background, not evidence)",
    inferred_hypothesis: "INFERRED (lower confidence — use carefully)",
  };

  // Build with char budget: caution+relationship unlimited, others capped
  const parts: string[] = ["=== LEAD CONTEXT (from import/notes — NOT from live conversation) ==="];
  let totalChars = 0;
  const MAX_CHARS = 1500;

  for (const category of LEAD_CONTEXT_CATEGORY_PRIORITY) {
    const lines = groups.get(category);
    if (!lines || lines.length === 0) continue;

    const label = CATEGORY_LABELS[category] || category.toUpperCase();
    const section = `\n${label}:\n${lines.join("\n")}`;

    // Caution and relationship_history always included (safety-critical)
    if (category === "caution" || category === "relationship_history") {
      parts.push(section);
      totalChars += section.length;
    } else if (totalChars + section.length <= MAX_CHARS) {
      parts.push(section);
      totalChars += section.length;
    } else {
      // Truncate remaining items
      const remaining = MAX_CHARS - totalChars;
      if (remaining > 100) {
        parts.push(section.slice(0, remaining) + "\n[...truncated]");
      }
      break;
    }
  }

  // Add behavioral rules based on what context exists
  const rules: string[] = [];
  if (groups.has("relationship_history")) {
    rules.push("- This lead has PRIOR relationship history. Do NOT open as if they are completely unknown.");
  }
  if (groups.has("commercial_signal")) {
    const signals = groups.get("commercial_signal")!.join(" ").toLowerCase();
    if (signals.includes("product")) {
      rules.push("- This lead already owns/uses a product. Do NOT re-pitch what they already have.");
    }
    if (signals.includes("competitor")) {
      rules.push("- Competitor intel exists. You may differentiate, but do NOT bash competitors.");
    }
  }
  if (groups.has("caution")) {
    rules.push("- CAUTION items above are mandatory constraints. Violating them is a critical error.");
  }
  if (rules.length > 0) {
    parts.push(`\nRULES FROM LEAD CONTEXT:\n${rules.join("\n")}`);
  }
  parts.push("===");

  return parts.join("\n");
}

// ============================================
// KNOWLEDGE BASE CONFIG & RETRIEVAL
// ============================================

const TASK_KB_CONFIG: Record<string, string[]> = {
  // Outbound / cold — messaging-first
  email_intro_fast: ["messaging", "knowledge", "industry"],
  email_intro_nurture: ["messaging", "knowledge", "industry"],
  pre_email_1_intro: ["messaging", "knowledge", "industry"],
  inbound_intro: ["messaging", "knowledge", "industry", "case_study"],
  re_engagement_intro: ["messaging", "knowledge", "industry", "case_study"],
  followup_sequence_4: ["messaging", "knowledge"],
  linkedin_followup: ["messaging", "knowledge"],

  // Last-mile / reply — narrow core, expanded on signal below
  reply_to_thread: ["objection", "case_study", "knowledge", "messaging"],
  answer_questions: ["knowledge", "objection", "case_study", "messaging"],

  // Post-meeting
  post_meeting_recap: ["knowledge", "discovery", "strategy", "case_study"],
  post_meeting_followup_personalized: ["knowledge", "discovery", "strategy", "case_study", "objection"],
  post_meeting_followup_email: ["knowledge", "discovery", "case_study"],

  // Nurture
  nurture_sequence: ["messaging", "industry", "case_study"],
  nurture_email_single: ["messaging", "industry", "case_study"],

  // Analysis
  extract_milestones_risks: ["strategy", "signal"],
  extract_deal_factors: ["strategy", "signal", "competitor"],
  recommend_next_steps: ["strategy", "signal", "knowledge", "case_study", "objection"],
  lead_deep_analysis: ["strategy", "signal", "industry", "competitor"],
};

// Dynamically expand reply_to_thread KB types based on inbound message signals
function getExpandedKBTypes(task: string, latestInbound?: string, decision?: ClassifiedDecision, stagePolicy?: ResolvedPolicy): string[] {
  const base = TASK_KB_CONFIG[task];
  if (!base) return [];
  const expanded = [...base];

  // Decision-driven KB boost for last-mile tasks
  if (decision && decision.kb_boost_types.length > 0 && OFFER_ROUTED_TASKS.has(task)) {
    for (const t of decision.kb_boost_types) {
      if (!expanded.includes(t)) {
        expanded.push(t);
        console.log(`[ai_task] KB expansion: +${t} (decision boost: ${decision.detected_objection_classes[0] || "intent"})`);
      }
    }
    // Also boost stage-preferred KB types
    if (stagePolicy) {
      for (const t of stagePolicy.final_preferred_kb_types) {
        if (!expanded.includes(t)) {
          expanded.push(t);
          console.log(`[ai_task] KB expansion: +${t} (stage=${stagePolicy.effective_stage})`);
        }
      }
    }
    return expanded;
  }

  if (task !== "reply_to_thread" || !latestInbound) return expanded;

  const lower = latestInbound.toLowerCase();

  // Comparison signals → add competitor
  if (/compet|alternative|vs\b|compared|switch|other (option|vendor|provider|solution)|currently using|already (have|use)/i.test(lower)) {
    if (!expanded.includes("competitor")) expanded.push("competitor");
    console.log("[ai_task] KB expansion: +competitor (comparison signal)");
  }

  // Discovery / qualification signals → add discovery
  if (/how (does|do|would|can)|what (is|are)|explain|tell me more|walk me through|understand|curious about|looking (to|for|into)/i.test(lower)) {
    if (!expanded.includes("discovery")) expanded.push("discovery");
    console.log("[ai_task] KB expansion: +discovery (qualification signal)");
  }

  return expanded;
}

const KNOWLEDGE_SEARCH_TASKS = Object.keys(TASK_KB_CONFIG);
const MAX_KB_CHUNKS = 6;
const MAX_PER_CONTENT_TYPE = 2;

const ANALYSIS_TASKS = new Set([
  "post_meeting_recap", "post_meeting_followup_personalized", "post_meeting_followup_email",
  "extract_milestones_risks", "extract_deal_factors", "recommend_next_steps", "lead_deep_analysis",
]);
const KB_CHAR_LIMIT_OUTBOUND = 1200;
const KB_CHAR_LIMIT_ANALYSIS = 2400;

function getKbCharLimit(task: string): number {
  return ANALYSIS_TASKS.has(task) ? KB_CHAR_LIMIT_ANALYSIS : KB_CHAR_LIMIT_OUTBOUND;
}

// ============================================
// OFFER ROUTING — Structured commercial recommendation
// ============================================

const OFFER_ROUTED_TASKS = new Set([
  "reply_to_thread", "answer_questions", "post_meeting_followup_personalized",
  "post_meeting_followup_email", "recommend_next_steps",
]);

interface OfferMatch {
  offer_key: string;
  offer_name: string;
  link_url: string | null;
  cta_type: string;
  customer_facing_summary: string;
  internal_notes: string | null;
  score: number;
  match_reason: string;
}

async function routeOffer(
  adminClient: ReturnType<typeof createClient>,
  workspaceId: string,
  leadId: string,
  latestInbound: string,
  stage: string,
  channel: string,
  leadTags?: string[],
  leadSegment?: string,
  objections?: string[],
  decision?: ClassifiedDecision,
  stagePolicy?: ResolvedPolicy,
  continuityMemory?: DealMemory,
  continuityHintsForOffer?: ContinuityHints,
): Promise<{ recommended: OfferMatch | null; fallback_reason: string }> {
  try {
    // 1. Fetch active offers for workspace
    const { data: offers, error } = await adminClient
      .from("offer_registry")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .order("priority", { ascending: false });

    if (error || !offers || offers.length === 0) {
      return { recommended: null, fallback_reason: "No active offers configured for this workspace" };
    }

    const lowerInbound = latestInbound.toLowerCase();

    // 2. Score each offer
    const scored: OfferMatch[] = [];

    for (const offer of offers) {
      let score = 0;
      const reasons: string[] = [];

      // Stage match
      const allowedStages: string[] = offer.allowed_stages || [];
      if (allowedStages.length > 0 && !allowedStages.includes(stage)) continue;

      // Channel match
      const allowedChannels: string[] = offer.allowed_channels || [];
      if (allowedChannels.length > 0 && !allowedChannels.includes(channel)) continue;

      // Trigger phrase match (strongest signal)
      const triggerPhrases: string[] = offer.trigger_phrases || [];
      for (const phrase of triggerPhrases) {
        if (lowerInbound.includes(phrase.toLowerCase())) {
          score += 10;
          reasons.push(`phrase:"${phrase}"`);
        }
      }

      // Trigger tag match
      const triggerTags: string[] = offer.trigger_tags || [];
      if (leadTags && leadTags.length > 0) {
        for (const tag of triggerTags) {
          if (leadTags.includes(tag)) {
            score += 5;
            reasons.push(`tag:"${tag}"`);
          }
        }
      }

      // Objection match
      const relatedObjections: string[] = offer.related_objections || [];
      if (objections && objections.length > 0) {
        for (const obj of relatedObjections) {
          const objLower = obj.toLowerCase();
          if (objections.some(o => o.toLowerCase().includes(objLower) || objLower.includes(o.toLowerCase()))) {
            score += 8;
            reasons.push(`objection:"${obj}"`);
          }
        }
      }

      // Segment match
      const relatedSegments: string[] = offer.related_segments || [];
      if (leadSegment && relatedSegments.includes(leadSegment)) {
        score += 4;
        reasons.push(`segment:"${leadSegment}"`);
      }

      // Priority boost
      score += (offer.priority || 1);

      // Decision-aware scoring: boost/penalize by offer category
      if (decision && offer.offer_category) {
        score = adjustOfferScore(score, offer.offer_category, decision);
      }

      // Stage-aware scoring: boost/penalize by stage policy
      if (stagePolicy && offer.offer_category) {
        score = adjustOfferScoreByStage(score, offer.offer_category, stagePolicy);
      }

      // Continuity-aware scoring: penalize repeated offers/assets/CTAs
      if (continuityMemory && continuityHintsForOffer && offer.offer_category) {
        const contAdj = adjustOfferScoreByContinuity(
          score, offer.offer_key, offer.offer_category, offer.cta_type || "soft_offer",
          continuityMemory, continuityHintsForOffer,
        );
        if (contAdj.penalties_applied.length > 0) {
          console.log(`[ai_task] Offer continuity: ${offer.offer_key} → ${contAdj.penalties_applied.join(", ")}`);
        }
        score = contAdj.adjusted_score;
      }

      if (score > 0 || reasons.length > 0) {
        scored.push({
          offer_key: offer.offer_key,
          offer_name: offer.offer_name,
          link_url: offer.link_url,
          cta_type: offer.cta_type,
          customer_facing_summary: offer.customer_facing_summary,
          internal_notes: offer.internal_notes,
          score,
          match_reason: reasons.length > 0 ? reasons.join(", ") : `priority:${offer.priority}`,
        });
      }
    }

    if (scored.length === 0) {
      return { recommended: null, fallback_reason: "No offers matched the current lead context, stage, or inbound message" };
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // 3. Enhanced deduplicate — check exact link, offer family, and CTA pattern
    try {
      const { data: recentTimeline } = await adminClient
        .from("lead_timeline_items")
        .select("snippet_text, metadata_json")
        .eq("lead_id", leadId)
        .eq("direction", "outbound")
        .order("occurred_at", { ascending: false })
        .limit(10);

      if (recentTimeline && recentTimeline.length > 0) {
        const dedupeCtx = buildDedupeContext(recentTimeline as any[]);

        // Try to find first offer that passes all dedupe checks
        for (const offer of scored) {
          const verdict = checkOfferDedupe(
            offer.offer_key,
            (offers.find((o: any) => o.offer_key === offer.offer_key) as any)?.offer_category || "general",
            offer.link_url,
            offer.cta_type,
            dedupeCtx,
          );
          if (verdict === "ok") {
            console.log(`[ai_task] Offer routed: ${offer.offer_key} (score: ${offer.score}, reason: ${offer.match_reason})`);
            return { recommended: offer, fallback_reason: "" };
          }
          console.log(`[ai_task] Offer dedup: ${offer.offer_key} → ${verdict}, trying next`);
        }

        // All top offers hit dedupe — use top but note it
        console.log(`[ai_task] Offer routed (dedup-fallback): ${scored[0].offer_key} (all top matches recently sent)`);
        return { recommended: scored[0], fallback_reason: "Note: this offer/link was recently shared with this prospect" };
      }
    } catch (dedupeErr) {
      console.error("[ai_task] Offer dedup check failed:", dedupeErr);
    }

    console.log(`[ai_task] Offer routed: ${scored[0].offer_key} (score: ${scored[0].score}, reason: ${scored[0].match_reason})`);
    return { recommended: scored[0], fallback_reason: "" };
  } catch (err) {
    console.error("[ai_task] Offer routing failed:", err);
    return { recommended: null, fallback_reason: "Offer routing failed due to an internal error" };
  }
}

function formatOfferBlock(match: OfferMatch | null, fallbackReason: string): string {
  if (!match) {
    return `=== COMMERCIAL RECOMMENDATION ===\nNo specific offer matched. ${fallbackReason}\nUse general knowledge base context for the reply. Do not invent products or links.\n=== END COMMERCIAL RECOMMENDATION ===`;
  }

  const parts = [
    "=== COMMERCIAL RECOMMENDATION ===",
    `Recommended Offer: ${match.offer_name}`,
    `Offer Summary: ${match.customer_facing_summary}`,
  ];
  if (match.link_url) parts.push(`Link: ${match.link_url}`);
  parts.push(`CTA Type: ${match.cta_type}`);
  parts.push(`Match Reason: ${match.match_reason}`);
  if (match.internal_notes) parts.push(`Internal Notes (do NOT share with customer): ${match.internal_notes}`);
  if (fallbackReason) parts.push(`Note: ${fallbackReason}`);
  parts.push(
    "",
    "Instructions:",
    "- Weave this offer naturally into your reply when relevant",
    "- Use the customer-facing summary as the basis for your description",
    "- Include the link if present and appropriate for the conversation",
    "- Do NOT force the offer if the prospect is asking a different question",
    "- Do NOT include more than 1-2 links total in the reply",
    "- Do NOT repeat internal notes to the customer",
    "=== END COMMERCIAL RECOMMENDATION ==="
  );
  return parts.join("\n");
}

interface KBChunksGrouped { [contentType: string]: string; }

async function generateQueryEmbedding(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
    });
    if (!response.ok) { const errText = await response.text(); console.error(`[ai_task] Embedding API error (${response.status}):`, errText.slice(0, 200)); return null; }
    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (err) { console.error("[ai_task] Failed to generate query embedding:", err); return null; }
}

async function getSemanticKnowledgeChunks(
  queryText: string, supabaseUrl: string, supabaseServiceKey: string, userId: string, leadId?: string, contentTypes?: string[], avoidChunkIds?: string[]
): Promise<{ grouped: KBChunksGrouped; chunkIds: string[] } | null> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) { console.log("[ai_task] No OPENAI_API_KEY — falling back to text search"); return null; }
  const queryEmbedding = await generateQueryEmbedding(queryText, openaiKey);
  if (!queryEmbedding) { console.warn("[ai_task] Failed to generate query embedding — falling back to text search"); return null; }
  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const fetchCount = contentTypes ? Math.max(contentTypes.length * 4, 12) : MAX_KB_CHUNKS * 2;
    const { data: matches, error } = await supabaseAdmin.rpc("match_knowledge_chunks_v2", {
      query_embedding: JSON.stringify(queryEmbedding), p_owner_user_id: userId, match_threshold: 0.4,
      match_count: fetchCount, filter_customer_facing: true, filter_lead_id: leadId || null, filter_content_types: contentTypes || null,
    });
    if (error) { console.error("[ai_task] Semantic search failed:", error); return null; }
    if (!matches || matches.length === 0) { console.log("[ai_task] No semantic matches found"); return null; }

    // Item 6: Apply priority boost; Item 7: deprioritize recently used chunks
    const avoidSet = new Set(avoidChunkIds || []);
    const scored = matches.map((m: any) => {
      let adjustedSim = m.similarity || 0;
      const priority = m.priority ?? 1;
      adjustedSim += (priority - 1) * 0.03;
      if (avoidSet.has(m.id)) adjustedSim -= 0.08;
      return { ...m, adjustedSim };
    });
    scored.sort((a: any, b: any) => b.adjustedSim - a.adjustedSim);

    // Item 1: Allow up to MAX_PER_CONTENT_TYPE chunks per content_type
    const grouped: KBChunksGrouped = {};
    const typeCounts: Record<string, number> = {};
    const chunkIds: string[] = [];
    let count = 0;
    for (const m of scored) {
      const ct = m.content_type || "knowledge";
      const currentCount = typeCounts[ct] || 0;
      if (currentCount >= MAX_PER_CONTENT_TYPE) continue;
      const entry = `${m.title ? `[${m.title}] ` : ""}${m.content}`;
      grouped[ct] = grouped[ct] ? `${grouped[ct]}\n\n${entry}` : entry;
      typeCounts[ct] = currentCount + 1;
      chunkIds.push(m.id);
      count++;
      if (count >= MAX_KB_CHUNKS) break;
    }
    console.log(`[ai_task] Semantic: ${matches.length} raw → ${count} selected (${Object.keys(grouped).join(",")}), top sim: ${matches[0]?.similarity?.toFixed(3)}${avoidSet.size > 0 ? `, avoided: ${avoidSet.size}` : ""}`);
    return { grouped, chunkIds };
  } catch (err) { console.error("[ai_task] Error in semantic search:", err); return null; }
}

async function getTextBasedKnowledgeChunks(
  queryText: string, supabaseUrl: string, supabaseServiceKey: string, userId: string, leadId?: string, avoidChunkIds?: string[]
): Promise<{ grouped: KBChunksGrouped; chunkIds: string[] } | null> {
  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    let query = supabaseAdmin.from("kb_chunks").select("id, title, content, source, content_type, priority")
      .eq("owner_user_id", userId).eq("allowed_customer_facing", true).eq("processing_status", "completed").limit(12);
    if (leadId) query = query.or(`lead_id.eq.${leadId},lead_id.is.null`);
    const keyTerms = queryText.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(term => term.length > 4).slice(0, 5);
    if (keyTerms.length > 0) query = query.or(keyTerms.map(term => `content.ilike.%${term}%`).join(','));
    const { data: matches, error } = await query;
    if (error) { console.error("[ai_task] Text search failed:", error); return null; }
    if (!matches || matches.length === 0) { console.log("[ai_task] No text matches found"); return null; }

    // Sort by priority descending, deprioritize recently used
    const avoidSet = new Set(avoidChunkIds || []);
    const sorted = [...matches].sort((a: any, b: any) => {
      const pa = (a.priority ?? 1) - (avoidSet.has(a.id) ? 2 : 0);
      const pb = (b.priority ?? 1) - (avoidSet.has(b.id) ? 2 : 0);
      return pb - pa;
    });

    const grouped: KBChunksGrouped = {};
    const typeCounts: Record<string, number> = {};
    const chunkIds: string[] = [];
    let count = 0;
    for (const m of sorted) {
      const ct = (m as any).content_type || "knowledge";
      const currentCount = typeCounts[ct] || 0;
      if (currentCount >= MAX_PER_CONTENT_TYPE) continue;
      const entry = `${m.title ? `[${m.title}] ` : ""}${m.content}`;
      grouped[ct] = grouped[ct] ? `${grouped[ct]}\n\n${entry}` : entry;
      typeCounts[ct] = currentCount + 1;
      chunkIds.push(m.id);
      count++;
      if (count >= MAX_KB_CHUNKS) break;
    }
    console.log(`[ai_task] Text fallback: ${matches.length} raw → ${count} selected (${Object.keys(grouped).join(",")})`);
    return { grouped, chunkIds };
  } catch (err) { console.error("[ai_task] Error in text search:", err); return null; }
}

function formatKBContext(grouped: KBChunksGrouped, charLimit: number): string {
  const parts: string[] = [];
  let totalLen = 0;
  for (const [contentType, content] of Object.entries(grouped)) {
    const label = contentType.toUpperCase();
    const entry = `[${label}]\n${content}`;
    if (totalLen + entry.length > charLimit) {
      const remaining = charLimit - totalLen;
      if (remaining > 50) parts.push(`[${label}]\n${content.slice(0, remaining - label.length - 4)}…`);
      break;
    }
    parts.push(entry);
    totalLen += entry.length;
  }
  return parts.join("\n\n---\n\n");
}

async function getKnowledgeContext(
  queryText: string, supabaseUrl: string, supabaseServiceKey: string, userId: string, leadId?: string, task?: string, latestInbound?: string, decision?: ClassifiedDecision, stagePolicy?: ResolvedPolicy
): Promise<{ formatted: string; grouped: KBChunksGrouped; chunkIds: string[] }> {
  // Use dynamic expansion for reply_to_thread based on inbound signals + decision context + stage policy
  const contentTypes = task ? getExpandedKBTypes(task, latestInbound, decision, stagePolicy) : undefined;
  const charLimit = task ? getKbCharLimit(task) : KB_CHAR_LIMIT_OUTBOUND;
  if (contentTypes && contentTypes.length > 0) console.log(`[ai_task] Task "${task}" → KB types: [${contentTypes.join(", ")}], limit: ${charLimit} chars`);

  // Item 7: Fetch recently used chunk IDs for this lead (soft repetition avoidance)
  let avoidChunkIds: string[] = [];
  if (leadId) {
    try {
      const cacheClient = createClient(supabaseUrl, supabaseServiceKey);
      const { data: recentLogs } = await cacheClient
        .from("message_generation_log")
        .select("kb_chunk_ids")
        .eq("lead_id", leadId)
        .not("kb_chunk_ids", "is", null)
        .order("created_at", { ascending: false })
        .limit(5);
      if (recentLogs) {
        for (const log of recentLogs) {
          const ids = (log as any).kb_chunk_ids;
          if (Array.isArray(ids)) avoidChunkIds.push(...ids);
        }
        avoidChunkIds = [...new Set(avoidChunkIds)];
        if (avoidChunkIds.length > 0) console.log(`[ai_task] KB repetition avoidance: ${avoidChunkIds.length} recently used chunk IDs`);
      }
    } catch (err) { console.error("[ai_task] Failed to load recent KB chunk IDs:", err); }
  }

  let result = await getSemanticKnowledgeChunks(queryText, supabaseUrl, supabaseServiceKey, userId, leadId, contentTypes, avoidChunkIds);
  if (!result) {
    console.log("[ai_task] Falling back to text-based KB search");
    result = await getTextBasedKnowledgeChunks(queryText, supabaseUrl, supabaseServiceKey, userId, leadId, avoidChunkIds);
  }
  if (!result || Object.keys(result.grouped).length === 0) return { formatted: "", grouped: {}, chunkIds: [] };
  return { formatted: formatKBContext(result.grouped, charLimit), grouped: result.grouped, chunkIds: result.chunkIds };
}

// ============================================
// CORS & UTILS
// ============================================

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isCustomDomain = origin === "https://drivepilot.app" || origin === "https://www.drivepilot.app";
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || isCustomDomain || allowedOrigins.includes("*");
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const QUALITY_THRESHOLD = 24;

interface EmailQualityScore {
  curiosity: number;
  human_tone: number;
  spam_risk: number;
  reply_likelihood: number;
  summary: string;
}

const QUALITY_SCORED_TASKS = new Set([
  "pre_email_1_intro", "pre_email_2_followup", "pre_email_3_followup", "pre_email_4_breakup",
  "email_intro_fast", "email_intro_nurture", "re_engagement_intro",
]);

const PRO_MODEL_TASKS = [
  "post_meeting_recap", "extract_milestones_risks", "extract_deal_factors",
  "recommend_next_steps", "lead_deep_analysis", "post_meeting_followup_personalized",
];

const LITE_MODEL_TASKS = ["intent_router", "analyze_outgoing_email"];

function replaceTemplateVars(template: string, payload: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(payload)) {
    const placeholder = `{{${key.toUpperCase()}}}`;
    const replacement = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    result = result.split(placeholder).join(replacement);
  }
  result = result.replace(/\{\{[A-Z_]+\}\}/g, "");
  return result;
}

// ============================================
// MAIN HANDLER
// ============================================

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const token = authHeader.replace("Bearer ", "");
    const isServiceRole = token === supabaseServiceKey;
    
    let user: { id: string } | null = null;
    
    if (isServiceRole) {
      user = { id: "service-role" };
    } else {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
      if (authError || !authUser) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = authUser;
    }

    // Resolve actual owner_user_id for service-role calls
    let resolvedUserId = user.id;
    if (isServiceRole) {
      const { task: _t, payload: _p } = await req.clone().json().catch(() => ({ task: null, payload: null }));
      if (_p?.lead_id) {
        try {
          const ownerClient = createClient(supabaseUrl, supabaseServiceKey);
          const { data: leadRow } = await ownerClient.from("leads").select("owner_user_id").eq("id", _p.lead_id).maybeSingle();
          if (leadRow?.owner_user_id) {
            resolvedUserId = leadRow.owner_user_id;
            console.log(`[ai_task] Resolved owner_user_id: ${resolvedUserId} from lead ${_p.lead_id}`);
          }
        } catch (err) { console.error("[ai_task] Failed to resolve owner from lead:", err); }
      }
    }

    const { task, payload } = await req.json();

    if (!task || typeof task !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing or invalid task" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const taskPrompt = PROMPTS[task];
    if (!taskPrompt) {
      return new Response(JSON.stringify({ ok: false, error: `Unknown task: ${task}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY is not configured");
      return new Response(JSON.stringify({ ok: false, error: "AI gateway not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const DEFAULT_CADENCE_SETTINGS = {
      version: 1,
      modes: {
        fast: { reply_pending_hours: 4, outbound_followups_days: [2, 3, 3, 4], breakup_trigger: { days_since_first_outbound: 10, days_since_last_outbound: 5 }, post_meeting: { recap_suggest_after_hours: 4, checkins_days: [3, 7] } },
        nurture: { reply_pending_hours: 24, outbound_followups_days: [5, 7, 7, 10], breakup_trigger: { days_since_first_outbound: 30, days_since_last_outbound: 14 }, post_meeting: { recap_suggest_after_hours: 24, checkins_days: [7, 14, 30] } },
      },
      flows: { nurture_campaigns: { enabled: true, cadences_days: { weekly: 7, biweekly: 14, monthly: 30 }, min_days_after_last_touch: 7 } },
    };

    let enhancedPayload = { ...payload };
    let knowledgeContextUsed = false;

    let cadenceSettings = DEFAULT_CADENCE_SETTINGS;
    let cadencePromise: Promise<void> = Promise.resolve();
    if (payload?.lead_id) {
      cadencePromise = (async () => {
        try {
          const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data: combined } = await adminClient.from("leads")
            .select("owner_user_id, workspace_profiles!inner(cadence_settings)")
            .eq("id", payload.lead_id).maybeSingle();
          const wsCadence = (combined as any)?.workspace_profiles?.cadence_settings;
          if (wsCadence) {
            cadenceSettings = { ...DEFAULT_CADENCE_SETTINGS, ...wsCadence, modes: {
              fast: { ...DEFAULT_CADENCE_SETTINGS.modes.fast, ...wsCadence?.modes?.fast },
              nurture: { ...DEFAULT_CADENCE_SETTINGS.modes.nurture, ...wsCadence?.modes?.nurture },
            }};
            console.log(`[ai_task] Loaded workspace cadence settings (joined)`);
          }
        } catch (err) { console.error("[ai_task] Failed to load cadence settings, using defaults:", err); }
      })();
    }

    if (task === "followup_sequence_4") {
      const mode = (payload?.mode || "fast") as "fast" | "nurture";
      const cadenceDays = cadenceSettings.modes[mode]?.outbound_followups_days || [2, 3, 3, 4];
      enhancedPayload.cadence_days = JSON.stringify(cadenceDays);
      console.log(`[ai_task] Injected cadence_days for ${mode} mode: ${JSON.stringify(cadenceDays)}`);
    }
    
    const motion = String(enhancedPayload.motion || "");
    const isFirstTouch = enhancedPayload.first_touch === true;
    const isOutboundFirstTouch = motion === "outbound_prospecting" && isFirstTouch;

    // Resolve workspace_id early — needed by deal memory, diversity, and logging
    let resolvedWorkspaceId: string | null = null;
    if (payload?.lead_id) {
      try {
        const wsClient = createClient(supabaseUrl, supabaseServiceKey);
        const { data: leadWs } = await wsClient.from("leads").select("workspace_id").eq("id", payload.lead_id).maybeSingle();
        resolvedWorkspaceId = leadWs?.workspace_id ?? null;
      } catch (err) { console.error("[ai_task] Failed to resolve workspace_id:", err); }
    }

    let contextCachePromise: Promise<Record<string, unknown> | null> = Promise.resolve(null);
    if (payload?.lead_id) {
      contextCachePromise = (async () => {
        try {
          const cacheClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data } = await cacheClient.from("lead_context_cache")
            .select("context_json, last_generated_at").eq("lead_id", payload.lead_id).maybeSingle();
          if (data) {
            const age = Date.now() - new Date(data.last_generated_at).getTime();
            if (age < 6 * 60 * 60 * 1000) {
              console.log(`[ai_task] ✅ Context cache hit for lead ${payload.lead_id}, age: ${Math.round(age / 60000)}min`);
              return data.context_json as Record<string, unknown>;
            }
            console.log(`[ai_task] Context cache expired for lead ${payload.lead_id}`);
          }

          // Cache miss/expired — inline-fetch lead_context_items as short-term fallback
          // Also fire-and-forget cache rebuild so subsequent calls hit the cache
          console.log(`[ai_task] Cache miss for lead ${payload.lead_id}, fetching lead_context_items inline`);
          const { data: contextItems } = await cacheClient
            .from("lead_context_items")
            .select("category, content_type, content_text, original_snippet, source_type, source_column_name, confidence, author_name, context_date, is_active")
            .eq("lead_id", payload.lead_id)
            .eq("is_active", true)
            .order("created_at", { ascending: true })
            .limit(50);

          // Fire-and-forget: trigger build-lead-context to populate the cache for next call
          try {
            const rebuildUrl = `${supabaseUrl}/functions/v1/build-lead-context`;
            fetch(rebuildUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "x-internal-secret": Deno.env.get("INTERNAL_API_SECRET") || "",
              },
              body: JSON.stringify({ lead_id: payload.lead_id, force: true }),
            }).catch(e => console.error("[ai_task] Background cache rebuild failed:", e));
            console.log(`[ai_task] Triggered background cache rebuild for ${payload.lead_id}`);
          } catch (_) { /* non-fatal */ }

          if (contextItems && contextItems.length > 0) {
            console.log(`[ai_task] ✅ Inline-fetched ${contextItems.length} lead_context_items (cache bypass, rebuild queued)`);
            return { lead_context_items: contextItems } as Record<string, unknown>;
          }

          return null;
        } catch (err) { console.error("[ai_task] Context cache lookup failed:", err); return null; }
      })();
    }

    let signalsPromise: Promise<{ type: string; description: string; source: string }[]> = Promise.resolve([]);
    if (payload?.lead_id) {
      signalsPromise = (async () => {
        try {
          const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data } = await adminClient.from("lead_signals")
            .select("signal_type, signal_description, source_url")
            .eq("lead_id", payload.lead_id).order("detected_at", { ascending: false }).limit(8);
          return (data || []).map((s: any) => ({ type: s.signal_type, description: s.signal_description, source: s.source_url || "" }));
        } catch (err) { console.error("[ai_task] Failed to load lead_signals:", err); return []; }
      })();
    }

    // Extract latest inbound for signal-aware KB expansion and offer routing
    // Check cross-channel inbound first (SMS, WhatsApp), then fall back to email
    const latestInbound = payload?.email_text ? String(payload.email_text)
      : (payload?.latest_inbound ? String(payload.latest_inbound)
      : undefined);
    const threadContext = payload?.thread_summary ? String(payload.thread_summary) : (payload?.previous_emails ? String(payload.previous_emails).slice(0, 1500) : undefined);
    if (payload?.latest_inbound_channel && payload?.latest_inbound_channel !== "email") {
      console.log(`[ai_task] Latest inbound source: ${payload.latest_inbound_channel} channel`);
    }

    // ── COMMERCIAL INTENT CLASSIFICATION (runs early to influence KB + offer routing) ──
    let commercialDecision: ClassifiedDecision | undefined;
    if (OFFER_ROUTED_TASKS.has(task) && latestInbound) {
      // We'll fetch intelligence inline for classification — lightweight query
      let intelligenceJson: Record<string, unknown> | null = null;
      if (payload?.lead_id) {
        try {
          const intClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data: intel } = await intClient.from("lead_intelligence")
            .select("objections_json, buying_signals_json, engagement_signals_json")
            .eq("lead_id", payload.lead_id).maybeSingle();
          if (intel) intelligenceJson = intel as Record<string, unknown>;
        } catch (err) { console.error("[ai_task] Intel fetch for classifier failed:", err); }
      }

      const leadTags: string[] = [];
      if (payload?.tags && Array.isArray(payload.tags)) leadTags.push(...payload.tags);
      const leadSegment = payload?.segment ? String(payload.segment) : undefined;
      const leadStage = payload?.stage ? String(payload.stage) : undefined;

      commercialDecision = classifyCommercialIntent(
        latestInbound, threadContext, intelligenceJson, leadStage, leadTags, leadSegment,
      );
      console.log(`[ai_task] [CLASSIFIER] objections=[${commercialDecision.detected_objection_classes}], intent=${commercialDecision.detected_commercial_intent}, confidence=${commercialDecision.confidence}, cta=${commercialDecision.cta_strategy}`);
    }

    // ── STAGE-AWARE DECISION POLICY (runs after classification) ──
    let resolvedStagePolicy: ResolvedPolicy | undefined;
    if (OFFER_ROUTED_TASKS.has(task) && commercialDecision) {
      const rawStage = payload?.stage ? String(payload.stage) : "new";
      // Detect repeat customer from motion or stage
      const isRepeatCustomer = payload?.motion === "expansion" || payload?.stage === "closed" ||
        (payload?.nurture_outbound_count && Number(payload.nurture_outbound_count) > 3 && payload?.stage === "engaged");
      resolvedStagePolicy = resolveStagePolicy(
        rawStage, commercialDecision, latestInbound || "", !!isRepeatCustomer,
      );
      console.log(`[ai_task] [STAGE_POLICY] effective=${resolvedStagePolicy.effective_stage}, cta=${resolvedStagePolicy.final_cta_strategy}, urgent=${resolvedStagePolicy.urgency.is_urgent}, reasoning=${resolvedStagePolicy.stage_reasoning}`);
    }

    // ── DEAL MEMORY (load before objective selection) ──
    let dealMemory: DealMemory | undefined;
    let continuityHints: ContinuityHints | undefined;
    if (OFFER_ROUTED_TASKS.has(task) && payload?.lead_id && resolvedWorkspaceId) {
      try {
        const memClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        dealMemory = await loadDealMemory(memClient, String(payload.lead_id), resolvedWorkspaceId);

        // Reconcile objections with canonical lead_intelligence
        if (payload?.lead_id) {
          try {
            const { data: intel } = await memClient.from("lead_intelligence")
              .select("objections_json")
              .eq("lead_id", payload.lead_id).maybeSingle();
            if (intel?.objections_json && Array.isArray(intel.objections_json)) {
              const canonicalObjs = (intel.objections_json as any[])
                .map((o: any) => typeof o === "string" ? o : o.text || o.description || "")
                .filter(Boolean);
              dealMemory = reconcileObjections(dealMemory, canonicalObjs);
            }
          } catch (reconErr) {
            console.error("[ai_task] Objection reconciliation failed:", reconErr);
          }
        }

        // Update from inbound
        if (latestInbound && commercialDecision) {
          dealMemory = updateFromInbound(
            dealMemory, latestInbound,
            commercialDecision.detected_objection_classes,
            commercialDecision.detected_commercial_intent,
          );
        }

        // Compute momentum
        const daysSinceInbound = payload?.last_inbound_at
          ? Math.floor((Date.now() - new Date(String(payload.last_inbound_at)).getTime()) / 86400000)
          : null;
        const recentReplyCount = payload?.recent_reply_count ? Number(payload.recent_reply_count) : 0;
        const hasBuyingSignals = commercialDecision?.detected_commercial_intent === "ready_to_buy";
        const hasNewObj = (commercialDecision?.detected_objection_classes.length ?? 0) > 0;
        dealMemory = computeMomentum(dealMemory, daysSinceInbound, recentReplyCount, hasBuyingSignals, hasNewObj);

        continuityHints = getContinuityHints(dealMemory);
        console.log(`[ai_task] [DEAL_MEMORY] momentum=${dealMemory.momentum_state}, risks=[${dealMemory.continuity_risks}], unresolved_obj=${dealMemory.unresolved_objections.length}, unanswered_q=${dealMemory.unanswered_questions.length}`);
      } catch (memErr) {
        console.error("[ai_task] Deal memory load failed:", memErr);
      }
    }

    // ── REPLY OBJECTIVE ORCHESTRATOR (runs after stage policy + memory) ──
    let replyObjective: ReplyObjectiveResult | undefined;
    let continuityInfluence: ContinuityObjectiveInfluence | undefined;
    if (OFFER_ROUTED_TASKS.has(task) && commercialDecision && resolvedStagePolicy && latestInbound) {
      // Use continuity-aware selection when deal memory is available
      if (dealMemory && continuityHints) {
        const { result, influence } = selectReplyObjectiveWithContinuity(
          latestInbound, commercialDecision, resolvedStagePolicy,
          dealMemory, continuityHints, task,
        );
        replyObjective = result;
        continuityInfluence = influence;

        // Apply momentum-based stage policy adjustments
        const momentumAdj = adjustStagePolicyByMomentum(resolvedStagePolicy, dealMemory, continuityHints);
        if (momentumAdj.reasoning.length > 0) {
          for (const s of momentumAdj.suppressed_cta_additions) {
            if (!resolvedStagePolicy.final_suppressed_cta_patterns.includes(s)) {
              resolvedStagePolicy.final_suppressed_cta_patterns.push(s);
            }
          }
          for (const p of momentumAdj.preferred_cta_additions) {
            if (!resolvedStagePolicy.final_preferred_cta_patterns.includes(p)) {
              resolvedStagePolicy.final_preferred_cta_patterns.unshift(p);
            }
          }
          if (momentumAdj.cta_overrides.length > 0) {
            resolvedStagePolicy.final_cta_strategy = momentumAdj.cta_overrides[0];
          }
          console.log(`[ai_task] [MOMENTUM_ADJ] ${momentumAdj.reasoning.join("; ")}`);
        }

        if (continuityInfluence.overrides_applied.length > 0) {
          console.log(`[ai_task] [CONTINUITY] overrides=[${continuityInfluence.overrides_applied.join(", ")}], original=${continuityInfluence.original_objective}→${continuityInfluence.final_objective}`);
        }
      } else {
        replyObjective = selectReplyObjective(
          latestInbound, commercialDecision, resolvedStagePolicy,
          dealMemory?.recent_cta_patterns, task,
        );
      }

      console.log(`[ai_task] [OBJECTIVE] primary=${replyObjective.primary}, secondary=${replyObjective.secondary || "none"}, confidence=${replyObjective.confidence}, override=${replyObjective.override_source || "none"}, reasoning=${replyObjective.reasoning}`);
    }

    let kbSearchPromise: Promise<{ formatted: string; grouped: KBChunksGrouped; chunkIds: string[] }> = Promise.resolve({ formatted: "", grouped: {}, chunkIds: [] });
    if (KNOWLEDGE_SEARCH_TASKS.includes(task)) {
      const queryParts: string[] = [];
      if (payload?.email_text) queryParts.push(String(payload.email_text));
      if (payload?.questions_list) queryParts.push(String(payload.questions_list));
      if (payload?.lead_context) queryParts.push(String(payload.lead_context).slice(0, 500));
      if (payload?.meeting_summary) queryParts.push(String(payload.meeting_summary).slice(0, 500));
      const searchQuery = queryParts.join("\n").slice(0, 2000);
      if (searchQuery.length > 50) {
        const leadId = payload?.lead_id ? String(payload.lead_id) : undefined;
        console.log(`[ai_task] Searching knowledge base. Query length: ${searchQuery.length}, lead_id: ${leadId || 'global'}`);
        kbSearchPromise = getKnowledgeContext(searchQuery, supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, resolvedUserId, leadId, task, latestInbound, commercialDecision, resolvedStagePolicy);
      }
    }

    // Offer routing for last-mile tasks
    let offerPromise: Promise<{ recommended: OfferMatch | null; fallback_reason: string }> = Promise.resolve({ recommended: null, fallback_reason: "" });
    if (OFFER_ROUTED_TASKS.has(task) && payload?.lead_id) {
      offerPromise = (async () => {
        try {
          const offerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          // Resolve workspace_id from lead
          const { data: leadRow } = await offerClient.from("leads")
            .select("workspace_id, stage, nurture_theme, personal_notes")
            .eq("id", payload.lead_id).maybeSingle();
          if (!leadRow?.workspace_id) return { recommended: null, fallback_reason: "No workspace found for lead" };

          // Extract objections from lead_intelligence if available
          let objections: string[] = [];
          const { data: intel } = await offerClient.from("lead_intelligence")
            .select("objections_json").eq("lead_id", payload.lead_id).maybeSingle();
          if (intel?.objections_json && Array.isArray(intel.objections_json)) {
            objections = (intel.objections_json as any[]).map((o: any) => typeof o === "string" ? o : o.text || o.description || "").filter(Boolean);
          }

          // Extract tags from payload or lead context
          const leadTags: string[] = [];
          if (payload?.tags && Array.isArray(payload.tags)) leadTags.push(...payload.tags);
          if (leadRow.nurture_theme) leadTags.push(leadRow.nurture_theme);

          const leadSegment = payload?.segment ? String(payload.segment) : undefined;

          return routeOffer(
            offerClient,
            leadRow.workspace_id,
            String(payload.lead_id),
            latestInbound || "",
            leadRow.stage || "engaged",
            resolveChannel(task, payload?.channel ? String(payload.channel) : undefined),
            leadTags.length > 0 ? leadTags : undefined,
            leadSegment,
            objections.length > 0 ? objections : undefined,
            commercialDecision,
            resolvedStagePolicy,
            dealMemory,
            continuityHints,
          );
        } catch (err) {
          console.error("[ai_task] Offer routing setup failed:", err);
          return { recommended: null, fallback_reason: "Offer routing error" };
        }
      })();
    }

    let diversityPromise: Promise<DiversityConstraints> = Promise.resolve({
      avoid_opening_types: [], avoid_angles: [], avoid_cta_types: [], preferred_angles: [], preferred_cta_types: [],
    });
    if (payload?.lead_id && OUTREACH_TASKS.has(task)) {
      diversityPromise = (async () => {
        try {
          const divClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data: membership } = await divClient.from("workspace_members")
            .select("workspace_id").eq("user_id", resolvedUserId).limit(1).maybeSingle();
          resolvedWorkspaceId = membership?.workspace_id || null;
          return buildDiversityConstraints(divClient, String(payload.lead_id), resolvedWorkspaceId, payload?.campaign_id ? String(payload.campaign_id) : null);
        } catch (err) { console.error("[ai_task] Diversity fetch failed:", err); return { avoid_opening_types: [], avoid_angles: [], avoid_cta_types: [], preferred_angles: [], preferred_cta_types: [] }; }
      })();
    }

    // ── STYLE LEARNING: fetch user's style profile for this channel+motion ──
    const STYLE_AWARE_TASKS = new Set([
      "pre_email_1_intro", "pre_email_2_followup", "pre_email_3_followup", "pre_email_4_breakup",
      "email_intro_fast", "email_intro_nurture", "re_engagement_intro",
      "reply_to_thread", "answer_questions",
      "post_meeting_followup_email", "post_meeting_followup_personalized",
      "nurture_email_single", "nurture_sequence",
      "sms_message", "whatsapp_message", "whatsapp_reply",
    ]);

    interface StyleProfileData {
      profile_json: Record<string, unknown>;
      example_count: number;
      directive_text?: string;
    }

    let styleProfilePromise: Promise<StyleProfileData | null> = Promise.resolve(null);
    if (STYLE_AWARE_TASKS.has(task) && resolvedUserId !== "service-role") {
      styleProfilePromise = (async () => {
        try {
          const styleClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          // Determine channel and motion from task
          const styleChannel = /sms/i.test(task) ? "sms" : /whatsapp/i.test(task) ? "whatsapp" : "email";
          const styleMotion = /reply|answer|thread/i.test(task) ? "reply_to_thread"
            : /nurture/i.test(task) ? "nurture"
            : /followup|follow_up/i.test(task) ? "follow_up"
            : "outbound_cold";

          // Fetch profile and directive in parallel
          const [profileResult, directiveResult] = await Promise.all([
            styleClient.from("user_style_profiles")
              .select("profile_json, example_count")
              .eq("user_id", resolvedUserId)
              .eq("channel", styleChannel)
              .eq("motion_type", styleMotion)
              .maybeSingle(),
            styleClient.from("user_style_directives")
              .select("directive_text, learning_paused")
              .eq("user_id", resolvedUserId)
              .maybeSingle(),
          ]);

          // If learning is paused, skip style injection
          if (directiveResult.data?.learning_paused) {
            console.log(`[ai_task] Style learning paused for user ${resolvedUserId}`);
            return null;
          }

          const profile = profileResult.data;
          if (!profile || profile.example_count < 5) {
            console.log(`[ai_task] Style profile: insufficient examples (${profile?.example_count ?? 0}/5 needed) for ${styleChannel}/${styleMotion}`);
            return null;
          }

          console.log(`[ai_task] ✅ Style profile loaded: ${styleChannel}/${styleMotion}, ${profile.example_count} examples`);
          return {
            profile_json: profile.profile_json as Record<string, unknown>,
            example_count: profile.example_count,
            directive_text: directiveResult.data?.directive_text || undefined,
          };
        } catch (err) {
          console.error("[ai_task] Style profile fetch failed:", err);
          return null;
        }
      })();
    }

    const [kbResult, , leadSignals, cachedContext, diversityConstraints, offerResult] = await Promise.all([
      kbSearchPromise, cadencePromise, signalsPromise, contextCachePromise, diversityPromise, offerPromise,
    ]);

    // ── LEAD CONTEXT ITEMS: structured prior knowledge ──
    let leadContextBlock = "";
    if (cachedContext) {
      if (Array.isArray(cachedContext.recommended_angles) && (cachedContext.recommended_angles as string[]).length > 0) {
        enhancedPayload.recommended_angles = `Recommended outreach angles:\n- ${(cachedContext.recommended_angles as string[]).join("\n- ")}`;
      }
      if (cachedContext.company_summary) enhancedPayload.company_intelligence = String(cachedContext.company_summary);
      if (cachedContext.previous_interactions_summary) enhancedPayload.interaction_summary = String(cachedContext.previous_interactions_summary);
      if (cachedContext.industry_context && String(cachedContext.industry_context) !== "No industry-specific context available.") {
        enhancedPayload.industry_intelligence = String(cachedContext.industry_context);
      }
      if (leadSignals.length === 0 && Array.isArray(cachedContext.signals) && (cachedContext.signals as any[]).length > 0) {
        enhancedPayload.signals = JSON.stringify(cachedContext.signals);
        console.log(`[ai_task] ✅ Injected ${(cachedContext.signals as any[]).length} signals from context cache`);
      }

      // Build LEAD CONTEXT block from lead_context_items (priority-ordered)
      const contextItems = cachedContext.lead_context_items;
      if (Array.isArray(contextItems) && contextItems.length > 0) {
        leadContextBlock = buildLeadContextBlock(contextItems as any[]);
        console.log(`[ai_task] ✅ LEAD CONTEXT block built from ${contextItems.length} items`);
      }
    }

    if (leadSignals.length > 0) {
      enhancedPayload.signals = JSON.stringify(leadSignals);
      console.log(`[ai_task] ✅ Injected ${leadSignals.length} lead signals into context`);
    }

    // === NEW: Build structured seller context from workspace_context for pre_email_1_intro ===
    const FIRST_TOUCH_TASKS = new Set(["pre_email_1_intro", "email_intro_fast", "re_engagement_intro"]);
    const isFirstTouchTask = FIRST_TOUCH_TASKS.has(task);

    if (isFirstTouchTask && isOutboundFirstTouch) {
      // Build SELLER_CONTEXT from workspace_context (product info, value props, use cases)
      const workspaceCtx = enhancedPayload.workspace_context ? String(enhancedPayload.workspace_context) : "";
      if (workspaceCtx) {
        enhancedPayload.seller_context = workspaceCtx;
        console.log(`[ai_task] ✅ Injected seller_context (${workspaceCtx.length} chars)`);
      } else {
        enhancedPayload.seller_context = "(No seller context available — use neutral observation approach)";
      }

      // Build LEAD_INTELLIGENCE from cached context (angles, company summary, signals)
      const intelligenceParts: string[] = [];
      if (enhancedPayload.company_intelligence) intelligenceParts.push(`Company: ${enhancedPayload.company_intelligence}`);
      if (enhancedPayload.recommended_angles) intelligenceParts.push(String(enhancedPayload.recommended_angles));
      if (enhancedPayload.industry_intelligence) intelligenceParts.push(`Industry Intel: ${enhancedPayload.industry_intelligence}`);
      enhancedPayload.lead_intelligence = intelligenceParts.length > 0
        ? intelligenceParts.join("\n")
        : "(No lead intelligence available — use neutral observation based on lead name/company/role only)";
      console.log(`[ai_task] ✅ Lead intelligence: ${intelligenceParts.length} sections`);

      // For first-touch: KB should be labeled as seller knowledge, not lead evidence
      if (kbResult.formatted) {
        const capped = kbResult.formatted.slice(0, 600);
        // Wrap KB in explicit seller label so prompt knows not to use as lead evidence
        enhancedPayload.knowledge_context = `(SELLER KNOWLEDGE — use ONLY to pick outreach angle, NOT as evidence about the lead)\n${capped}`;
        knowledgeContextUsed = true;
        console.log(`[ai_task] ✅ KB context labeled as SELLER KNOWLEDGE for first touch: ${capped.length} chars`);
      }
    } else {
      // Non-first-touch: standard KB injection
      if (kbResult.formatted) {
        if (isOutboundFirstTouch) {
          const capped = kbResult.formatted.slice(0, 600);
          enhancedPayload.knowledge_context = capped;
          knowledgeContextUsed = true;
          console.log(`[ai_task] ✅ KB context capped for first touch: ${capped.length}/${kbResult.formatted.length} chars`);
        } else {
          enhancedPayload.knowledge_context = kbResult.formatted;
          knowledgeContextUsed = true;
          console.log(`[ai_task] ✅ Structured KB context (${kbResult.formatted.length} chars, types: ${Object.keys(kbResult.grouped).join(",")})`);
        }
      } else if (KNOWLEDGE_SEARCH_TASKS.includes(task)) {
        console.log(`[ai_task] ⚠️ No KB matches found for task ${task}`);
      }
    }

    const playbookId = String(enhancedPayload.playbook_id || "general");
    const hasInbound = enhancedPayload.has_latest_inbound === true;

    // Inject cross-channel conversation history into the prompt context
    // This ensures the AI sees SMS, WhatsApp, email, and call interactions
    if (enhancedPayload.cross_channel_history) {
      console.log(`[ai_task] ✅ Cross-channel history injected (${String(enhancedPayload.cross_channel_history).length} chars)`);
    }

    // If latest_inbound_channel is non-email, log it for debugging
    if (enhancedPayload.latest_inbound_channel && enhancedPayload.latest_inbound_channel !== "email") {
      console.log(`[ai_task] ✅ Latest inbound from ${enhancedPayload.latest_inbound_channel}: "${String(enhancedPayload.latest_inbound || "").slice(0, 100)}"`);
    }

    console.log(`[ai_task] Flags — playbook: ${playbookId}, motion: ${motion}, first_touch: ${isFirstTouch}, has_inbound: ${hasInbound}`);

    // Gate meeting_link: only pass to cold outbound tasks if custom instructions explicitly request it
    const COLD_OUTBOUND_TASKS = new Set(["pre_email_1_intro", "pre_email_2_followup", "pre_email_3_followup", "pre_email_4_breakup", "re_engagement_intro"]);
    if (COLD_OUTBOUND_TASKS.has(task) && enhancedPayload.meeting_link) {
      const instructions = String(enhancedPayload.custom_instructions || "").toLowerCase();
      const mentionsMeeting = /meeting|calendar|book.*time|schedule.*call|meeting.*cta|include.*cta/i.test(instructions);
      if (!mentionsMeeting) {
        console.log(`[ai_task] 🚫 Stripped meeting_link for ${task} — not requested in custom instructions`);
        delete enhancedPayload.meeting_link;
      } else {
        console.log(`[ai_task] ✅ Meeting link kept for ${task} — requested in custom instructions`);
      }
    }

    // === INSTRUCTION PRIORITY: inject dynamic template blocks based on custom instructions ===
    const hasCustomInstructions = !!(enhancedPayload.custom_instructions && String(enhancedPayload.custom_instructions).trim().length > 0);
    const customInstructionsText = hasCustomInstructions ? String(enhancedPayload.custom_instructions).trim() : "";

    // Default word limits per task (no instructions)
    const DEFAULT_LENGTHS: Record<string, string> = {
      pre_email_1_intro: "40–75 words. Target 55 words. If you write more than 75 words, start over.",
      pre_email_2_followup: "Under 50 words. Count them.",
      pre_email_3_followup: "Under 60 words.",
      pre_email_4_breakup: "Under 40 words. Seriously — 40 words max.",
    };
    // Expanded word limits when custom instructions exist
    const INSTRUCTION_LENGTHS: Record<string, string> = {
      pre_email_1_intro: "60–120 words. You have custom instructions to fulfill — prioritize them over default brevity.",
      pre_email_2_followup: "50–90 words. You have custom instructions to fulfill — prioritize them over default brevity.",
      pre_email_3_followup: "60–100 words. You have custom instructions to fulfill — prioritize them over default brevity.",
      pre_email_4_breakup: "40–70 words. You have custom instructions to fulfill — prioritize them over default brevity.",
    };

    if (COLD_OUTBOUND_TASKS.has(task)) {
      // Inject the dynamic LENGTH_OVERRIDE
      enhancedPayload.LENGTH_OVERRIDE = hasCustomInstructions
        ? (INSTRUCTION_LENGTHS[task] || DEFAULT_LENGTHS[task] || "Under 75 words.")
        : (DEFAULT_LENGTHS[task] || "Under 75 words.");

      // Inject INSTRUCTIONS_PRIORITY_BLOCK — appears BEFORE length in the prompt
      if (hasCustomInstructions) {
        enhancedPayload.INSTRUCTIONS_PRIORITY_BLOCK = `=== MANDATORY CUSTOM INSTRUCTIONS (READ BEFORE LENGTH) ===
You MUST fulfill ALL of the following instructions. They take priority over word count targets.
If an instruction says "offer starter kit" → the email MUST mention the starter kit.
If an instruction says "include meeting CTA" → the email MUST include a meeting/calendar link.
If an instruction says "mention X" → the email MUST mention X.
Do NOT drop any instruction to save words. Instead, use the expanded word limit below.

Instructions:
${customInstructionsText}
=== END MANDATORY INSTRUCTIONS ===`;
        
        enhancedPayload.INSTRUCTION_CTA_NOTE = "\nNote: If custom instructions specify a particular CTA or offer, use that INSTEAD of a generic question.";
        console.log(`[ai_task] ✅ Instructions injected as priority block for ${task}: "${customInstructionsText.slice(0, 80)}..."`);
      } else {
        enhancedPayload.INSTRUCTIONS_PRIORITY_BLOCK = "";
        enhancedPayload.INSTRUCTION_CTA_NOTE = "";
      }

      // Remove old custom_instructions to avoid duplication — it's now in INSTRUCTIONS_PRIORITY_BLOCK
      delete enhancedPayload.custom_instructions;
    }

    const taskBody = replaceTemplateVars(taskPrompt, enhancedPayload);

    const isOutboundMotion = motion === "outbound_prospecting";
    const outboundStyle = String(enhancedPayload.outbound_style || "standard");
    const isFollowUp = task === "pre_email_2_followup" || task === "pre_email_3_followup" || task === "pre_email_4_breakup";
    const isBreakup = task === "pre_email_4_breakup";

    const motionBlock = buildMotionBlock({ motion, first_touch: isFirstTouch });

    const styleParts: string[] = [];
    const styleBlock = buildStyleModifier({ motion, first_touch: isFirstTouch, outbound_style: outboundStyle });
    if (styleBlock) styleParts.push(styleBlock);
    if (isFirstTouch && isOutboundMotion && !hasInbound) styleParts.push(getColdOutreachBlock(playbookId));
    if (isFollowUp && isOutboundMotion) styleParts.push(REPLY_PATTERNS_BLOCK);
    if (isBreakup) styleParts.push(BREAKUP_CLOSERS[playbookId] || BREAKUP_CLOSERS.general_sales);
    const styleModifier = styleParts.join("\n\n") || "";

    const playbookContext = enhancedPayload.playbook_context ? String(enhancedPayload.playbook_context) : "";

    const hasDiversityConstraints = OUTREACH_TASKS.has(task) && (
      diversityConstraints.avoid_opening_types.length > 0 ||
      diversityConstraints.avoid_angles.length > 0 ||
      diversityConstraints.avoid_cta_types.length > 0
    );
    const diversityBlock = hasDiversityConstraints ? formatDiversityBlock(diversityConstraints, OFFER_ROUTED_TASKS.has(task)) : "";
    if (diversityBlock) console.log("[ai_task] [4/DIVERSITY] Constraints injected");

    const resolvedChannel = resolveChannel(task, payload?.channel ? String(payload.channel) : undefined);
    const sequenceStep = resolveSequenceStep(task, payload?.sequence_step);
    
    let messagingFrameworkBlock = "";
    if (sequenceStep && !CHANNEL_FRAMEWORK_EXEMPT_TASKS.has(task)) {
      messagingFrameworkBlock = getSequenceFramework(resolvedChannel, sequenceStep);
    }
    if (!messagingFrameworkBlock) {
      messagingFrameworkBlock = getChannelFramework(task, resolvedChannel);
    }
    if (messagingFrameworkBlock) console.log(`[ai_task] [5/CHANNEL] ${resolvedChannel}${sequenceStep ? ` step=${sequenceStep}` : " (generic)"}`);

    let emailFrameworkBlock = "";
    let selectedFramework: EmailFramework | null = null;
    const isOutboundEmailTask = task === "pre_email_1_intro" || task === "email_intro_fast" || task === "re_engagement_intro";
    if (isOutboundEmailTask && isOutboundMotion) {
      selectedFramework = selectEmailFramework(
        leadSignals,
        enhancedPayload.industry ? String(enhancedPayload.industry) : undefined,
        enhancedPayload.lead_context ? String(enhancedPayload.lead_context) : undefined,
      );
      emailFrameworkBlock = getEmailFrameworkBlock(selectedFramework);
      console.log(`[ai_task] [6/FRAMEWORK] Selected: ${selectedFramework} (signals: ${leadSignals.length})`);
    }

    // Build tone block from per-lead outbound_tone
    const leadTone = String(enhancedPayload.outbound_tone || "direct");
    const toneBlock = buildToneBlock(leadTone);
    if (toneBlock) console.log(`[ai_task] [7/TONE] Lead tone override: ${leadTone}`);

    // === CRITICAL: Instructions go FIRST in prompt assembly ===
    // When custom instructions exist, inject them as the FIRST block so the LLM
    // sees them before any competing constraints (motion, tone, frameworks, etc.)
    const topLevelInstructionBlock = hasCustomInstructions
      ? `=== TOP PRIORITY: CAMPAIGN INSTRUCTIONS ===
The user has provided specific campaign instructions that MUST be fulfilled.
These instructions override default behavior and word limits.
You will see them again in the task prompt below. Do NOT ignore them.

Instructions to fulfill:
${customInstructionsText}
=== END TOP PRIORITY ===`
      : "";

    // ── NEW: Structured campaign instruction from resolver ─────
    // When automation-executor passes a campaign_instruction block,
    // it takes precedence as the canonical instruction set.
    const structuredCampaignBlock = enhancedPayload.campaign_instruction
      ? String(enhancedPayload.campaign_instruction)
      : "";
    if (structuredCampaignBlock) {
      console.log(`[ai_task] [8/CAMPAIGN] Structured campaign instruction injected (${structuredCampaignBlock.length} chars)`);
    }

    // Build offer recommendation block for last-mile tasks
    let offerBlock = "";
    if (OFFER_ROUTED_TASKS.has(task) && offerResult) {
      offerBlock = formatOfferBlock(offerResult.recommended, offerResult.fallback_reason);
      if (offerResult.recommended) {
        enhancedPayload.recommended_offer_key = offerResult.recommended.offer_key;
        enhancedPayload.recommended_offer_name = offerResult.recommended.offer_name;
        enhancedPayload.recommended_link_url = offerResult.recommended.link_url || "";
        enhancedPayload.recommended_cta_type = offerResult.recommended.cta_type;
        enhancedPayload.recommended_reason = offerResult.recommended.match_reason;
        console.log(`[ai_task] [9/OFFER] ${offerResult.recommended.offer_key} → ${offerResult.recommended.match_reason}`);
      } else {
        enhancedPayload.recommended_offer_key = "";
        enhancedPayload.recommended_reason = offerResult.fallback_reason;
        console.log(`[ai_task] [9/OFFER] No match: ${offerResult.fallback_reason}`);
      }
    }

    // Build commercial decision context block for last-mile tasks
    let decisionBlock = "";
    if (commercialDecision && OFFER_ROUTED_TASKS.has(task)) {
      decisionBlock = formatDecisionBlock(commercialDecision);
      // Also inject structured fields into payload for template vars
      enhancedPayload.detected_objection_classes = commercialDecision.detected_objection_classes.join(", ");
      enhancedPayload.detected_commercial_intent = commercialDecision.detected_commercial_intent;
      enhancedPayload.response_strategy = commercialDecision.response_strategy;
      enhancedPayload.proof_strategy = commercialDecision.proof_strategy;
      enhancedPayload.cta_strategy = commercialDecision.cta_strategy;
      if (decisionBlock) console.log(`[ai_task] [10/DECISION] Injected decision context (${commercialDecision.detected_objection_classes.length} objections, intent=${commercialDecision.detected_commercial_intent})`);
    }

    // Build stage-aware policy block for last-mile tasks
    let stagePolicyBlock = "";
    if (resolvedStagePolicy && OFFER_ROUTED_TASKS.has(task)) {
      stagePolicyBlock = formatStagePolicyBlock(resolvedStagePolicy);
      // Override decision-level fields with stage-resolved finals
      enhancedPayload.effective_stage_policy = resolvedStagePolicy.effective_stage;
      enhancedPayload.final_cta_strategy = resolvedStagePolicy.final_cta_strategy;
      enhancedPayload.final_preferred_offer_categories = resolvedStagePolicy.final_preferred_offer_categories.join(", ");
      enhancedPayload.final_suppressed_offer_categories = resolvedStagePolicy.final_suppressed_offer_categories.join(", ");
      enhancedPayload.stage_reasoning_summary = resolvedStagePolicy.stage_reasoning;
      if (resolvedStagePolicy.urgency.is_urgent) enhancedPayload.is_urgent = "true";
      console.log(`[ai_task] [11/STAGE_POLICY] Injected stage policy block (stage=${resolvedStagePolicy.effective_stage})`);
    }

    // Build reply objective block for last-mile tasks
    let objectiveBlock = "";
    if (replyObjective && OFFER_ROUTED_TASKS.has(task)) {
      objectiveBlock = formatObjectiveBlock(replyObjective);
      // Apply objective overrides to CTA and offer categories
      const overrides = applyObjectiveOverrides(
        replyObjective,
        resolvedStagePolicy?.final_cta_strategy || commercialDecision?.cta_strategy || "soft_offer",
        resolvedStagePolicy?.final_preferred_offer_categories || [],
        resolvedStagePolicy?.final_suppressed_offer_categories || [],
      );
      enhancedPayload.primary_reply_objective = replyObjective.primary;
      enhancedPayload.secondary_reply_objective = replyObjective.secondary || "";
      enhancedPayload.objective_reasoning = replyObjective.reasoning;
      enhancedPayload.final_cta_strategy = overrides.final_cta;
      enhancedPayload.final_preferred_offer_categories = overrides.final_preferred_offers.join(", ");
      enhancedPayload.final_suppressed_offer_categories = overrides.final_suppressed_offers.join(", ");
      if (replyObjective.override_source) enhancedPayload.objective_override_source = replyObjective.override_source;
      console.log(`[ai_task] [12/OBJECTIVE] primary=${replyObjective.primary}, cta→${overrides.final_cta}`);
    }

    const promptParts: string[] = [];
    if (topLevelInstructionBlock) promptParts.push(topLevelInstructionBlock);
    if (motionBlock) promptParts.push(motionBlock);
    if (toneBlock) promptParts.push(toneBlock);
    if (styleModifier) promptParts.push(styleModifier);
    if (messagingFrameworkBlock) promptParts.push(messagingFrameworkBlock);
    if (emailFrameworkBlock) promptParts.push(emailFrameworkBlock);
    if (structuredCampaignBlock) promptParts.push(structuredCampaignBlock);
    if (objectiveBlock) promptParts.push(objectiveBlock);          // Objective FIRST (controls everything)
    if (stagePolicyBlock) promptParts.push(stagePolicyBlock);      // Stage policy context
    if (decisionBlock) promptParts.push(decisionBlock);            // Decision context

    // Deal memory block — continuity context
    let dealMemoryBlock = "";
    if (dealMemory && OFFER_ROUTED_TASKS.has(task)) {
      dealMemoryBlock = formatDealMemoryBlock(dealMemory);
      console.log(`[ai_task] [13/DEAL_MEMORY] Injected deal memory block (momentum=${dealMemory.momentum_state})`);
    }
    if (dealMemoryBlock) promptParts.push(dealMemoryBlock);

    // Lead context block — prior knowledge from import/notes (injected AFTER deal memory, BEFORE offers)
    if (leadContextBlock) {
      promptParts.push(leadContextBlock);
      console.log(`[ai_task] [14/LEAD_CONTEXT] Lead context block injected`);
    }

    if (offerBlock) promptParts.push(offerBlock);

    // Cross-channel conversation history — injected near the end so it's close to the task body
    if (enhancedPayload.cross_channel_history) {
      promptParts.push(String(enhancedPayload.cross_channel_history));
      console.log(`[ai_task] [15/CROSS_CHANNEL] Cross-channel history injected`);
    }

    if (diversityBlock) promptParts.push(diversityBlock);
    if (playbookContext) promptParts.push(playbookContext);
    promptParts.push(taskBody);
    const userPrompt = promptParts.join("\n\n");

    if (topLevelInstructionBlock) console.log(`[ai_task] [0/INSTRUCTIONS] Campaign instructions injected at TOP of prompt`);
    if (motionBlock) console.log(`[ai_task] [1/MOTION] ${motion}${isFirstTouch ? " (first_touch)" : ""}`);
    if (styleModifier) console.log(`[ai_task] [2/STYLE] ${styleParts.length} block(s)`);
    if (playbookContext) console.log("[ai_task] [3/PLAYBOOK] Playbook context");
    console.log(`[ai_task] Channel: ${resolvedChannel}, Step: ${sequenceStep ?? "none"}, Framework: ${selectedFramework ?? "none"}`);

    const clientModelHint = payload?.model_hint ? String(payload.model_hint) : null;
    const model = clientModelHint && ["google/gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"].includes(clientModelHint)
      ? clientModelHint
      : PRO_MODEL_TASKS.includes(task) ? "google/gemini-2.5-pro"
      : LITE_MODEL_TASKS.includes(task) ? "google/gemini-2.5-flash-lite"
      : "google/gemini-2.5-flash";

    console.log(`[ai_task] Task: ${task}, Model: ${model}, User: ${user.id}`);

    const streamRequested = payload?.stream === true;

    // Build system prompt — append instruction reminder when present
    let systemPrompt = `${SYSTEM_GLOBAL_PROMPT}\n\nCurrent date: ${new Date().toISOString().split('T')[0]}`;
    if (hasCustomInstructions) {
      systemPrompt += `\n\nIMPORTANT SYSTEM OVERRIDE: The user has provided mandatory campaign instructions. You MUST fulfill every instruction. Do NOT drop them for brevity. Instructions: ${customInstructionsText}`;
    }

    const aiRequestBody: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: hasCustomInstructions ? 4096 : 2048,
    };

    if (streamRequested) aiRequestBody.stream = true;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(aiRequestBody),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded. Please try again later." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ ok: false, error: "Payment required. Please add credits to continue." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error(`[ai_task] AI gateway error (${response.status}):`, errorText.slice(0, 300));
      return new Response(JSON.stringify({ ok: false, error: `AI gateway returned ${response.status}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (streamRequested) {
      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    let aiResult = await response.json();
    let content = aiResult.choices?.[0]?.message?.content || "";

    // Log raw response details for debugging empty responses
    if (!content) {
      const finishReason = aiResult.choices?.[0]?.finish_reason || "unknown";
      const refusal = aiResult.choices?.[0]?.message?.refusal || null;
      console.error(`[ai_task] Empty content from primary model. finish_reason=${finishReason}, refusal=${refusal}, choices_count=${aiResult.choices?.length || 0}`);
      console.error(`[ai_task] Raw response keys: ${JSON.stringify(Object.keys(aiResult))}`);

      // Retry once with a different model
      console.log("[ai_task] Retrying with google/gemini-2.5-flash-lite...");
      const retryBody = { ...aiRequestBody, model: "google/gemini-2.5-flash-lite" };
      const retryResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(retryBody),
      });
      if (retryResponse.ok) {
        aiResult = await retryResponse.json();
        content = aiResult.choices?.[0]?.message?.content || "";
      }
    }

    content = stripLeakedReasoning(content);

    if (!content) {
      console.error("[ai_task] Empty response after retry");
      return new Response(JSON.stringify({ ok: false, error: "AI returned empty response" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Reply quality evaluation for last-mile tasks (OFFER_ROUTED_TASKS with orchestration context)
    let regenerated = false;
    let replyEvaluation: ReplyEvaluation | undefined;
    if (replyObjective && resolvedStagePolicy && OFFER_ROUTED_TASKS.has(task)) {
      try {
        const dealMemEvalCtx = dealMemory ? {
          shared_assets: dealMemory.shared_assets,
          sent_offers: dealMemory.sent_offers,
          recent_cta_patterns: dealMemory.recent_cta_patterns,
          momentum_state: dealMemory.momentum_state,
          ignored_cta_count: dealMemory.ignored_cta_count,
          handled_objections: dealMemory.handled_objections,
          unanswered_questions: dealMemory.unanswered_questions,
        } : undefined;
        replyEvaluation = evaluateReply(content, replyObjective, resolvedStagePolicy, commercialDecision, latestInbound || "", dealMemEvalCtx);
        console.log(`[ai_task] [EVALUATOR] score=${replyEvaluation.objective_alignment_score + replyEvaluation.cta_alignment_score + replyEvaluation.focus_score + replyEvaluation.commercial_relevance_score}/40, violations=${replyEvaluation.policy_violations.length}, regen=${replyEvaluation.regeneration_recommended}, dominant=${replyEvaluation.dominant_layer}`);

        if (replyEvaluation.regeneration_recommended) {
          const feedback = buildEvaluatorFeedback(replyEvaluation, replyObjective.primary);
          if (feedback) {
            console.log(`[ai_task] [EVALUATOR] Triggering one-pass regeneration...`);
            const regenPromptParts = [...promptParts, feedback];
            const regenResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model,
                messages: [
                  { role: "system", content: `${SYSTEM_GLOBAL_PROMPT}\n\nCurrent date: ${new Date().toISOString().split("T")[0]}` },
                  { role: "user", content: regenPromptParts.join("\n\n") },
                ],
              }),
            });
            if (regenResponse.ok) {
              const regenResult = await regenResponse.json();
              let regenContent = regenResult.choices?.[0]?.message?.content || "";
              regenContent = stripLeakedReasoning(regenContent);
              if (regenContent) {
                // Re-evaluate regenerated content
                const reEval = evaluateReply(regenContent, replyObjective, resolvedStagePolicy, commercialDecision, latestInbound || "", dealMemEvalCtx);
                const oldScore = replyEvaluation.objective_alignment_score + replyEvaluation.cta_alignment_score + replyEvaluation.focus_score + replyEvaluation.commercial_relevance_score;
                const newScore = reEval.objective_alignment_score + reEval.cta_alignment_score + reEval.focus_score + reEval.commercial_relevance_score;
                const oldObjAlign = replyEvaluation.objective_alignment_score;
                const newObjAlign = reEval.objective_alignment_score;
                console.log(`[ai_task] [EVALUATOR] Regen score: ${newScore}/40 obj=${newObjAlign} (was ${oldScore}/40 obj=${oldObjAlign})`);
                // Accept if total improved AND objective alignment didn't degrade
                if (newScore > oldScore && newObjAlign >= oldObjAlign) {
                  content = regenContent;
                  replyEvaluation = reEval;
                  regenerated = true;
                  console.log(`[ai_task] [EVALUATOR] Accepted regenerated reply`);
                } else {
                  console.log(`[ai_task] [EVALUATOR] Kept original (regen did not improve both total+objective)`);
                }
              }
            }
          }
        }
      } catch (evalErr) {
        console.error("[ai_task] Reply evaluation failed:", evalErr);
      }

      // Lightweight orchestration log for analytics/tuning
      if (replyEvaluation && resolvedWorkspaceId) {
        try {
          const logClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          await logClient.from("orchestration_log").insert({
            workspace_id: resolvedWorkspaceId,
            lead_id: payload?.lead_id ? String(payload.lead_id) : null,
            task_type: task,
            effective_stage: resolvedStagePolicy?.effective_stage ?? null,
            primary_objective: replyObjective?.primary ?? null,
            secondary_objective: replyObjective?.secondary ?? null,
            objective_confidence: replyObjective?.confidence ?? null,
            override_source: replyObjective?.override_source ?? null,
            dominant_layer: replyEvaluation.dominant_layer,
            objection_classes: commercialDecision?.detected_objection_classes ?? [],
            commercial_intent: commercialDecision?.detected_commercial_intent ?? null,
            cta_strategy: resolvedStagePolicy?.final_cta_strategy ?? null,
            is_urgent: resolvedStagePolicy?.urgency?.is_urgent ?? false,
            objective_alignment_score: replyEvaluation.objective_alignment_score,
            cta_alignment_score: replyEvaluation.cta_alignment_score,
            focus_score: replyEvaluation.focus_score,
            commercial_relevance_score: replyEvaluation.commercial_relevance_score,
            violation_rules: replyEvaluation.policy_violations.map(v => v.rule),
            regeneration_triggered: regenerated,
            offer_key: offerResult?.recommended?.offer_key ?? null,
          }).then(({ error }) => {
            if (error) console.error("[ai_task] Orchestration log insert failed:", error.message);
          });
        } catch (logErr) {
          console.error("[ai_task] Orchestration log failed:", logErr);
        }
      }
    }

    // Quality scoring for outbound emails
    let qualityScore: EmailQualityScore | null = null;
    let regenerated_outbound = regenerated;

    if (QUALITY_SCORED_TASKS.has(task)) {
      try {
        // Run quality score and grounding validation in parallel
        const [scoreResponse, groundingResponse] = await Promise.all([
          fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: QUALITY_SCORER_PROMPT },
                { role: "user", content: content },
              ],
            }),
          }),
          // Grounding validation for first-touch outbound
          isFirstTouchTask && isOutboundFirstTouch
            ? fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: GROUNDING_VALIDATOR_PROMPT },
                    { role: "user", content: `Generated Email:\n${content}\n\nLead Context:\n${enhancedPayload.lead_context || ""}\n\nSeller Context:\n${enhancedPayload.seller_context || enhancedPayload.workspace_context || ""}\n\nSignals:\n${enhancedPayload.signals || "None"}` },
                  ],
                }),
              })
            : Promise.resolve(null),
        ]);

        // Process grounding validation
        let groundingFailed = false;
        if (groundingResponse && groundingResponse.ok) {
          try {
            const groundingResult = await groundingResponse.json();
            const groundingText = groundingResult.choices?.[0]?.message?.content || "";
            const groundingMatch = groundingText.match(/\{[\s\S]*\}/);
            if (groundingMatch) {
              const grounding = JSON.parse(groundingMatch[0]);
              if (grounding.pass === false || grounding.safe_to_send === false) {
                groundingFailed = true;
                console.log(`[ai_task] ⚠️ GROUNDING VIOLATION detected: ${JSON.stringify(grounding.violations?.slice(0, 2))}`);
              } else {
                console.log(`[ai_task] ✅ Grounding validation passed`);
              }
            }
          } catch (gErr) { console.error("[ai_task] Grounding parse failed:", gErr); }
        }

        if (scoreResponse.ok) {
          const scoreResult = await scoreResponse.json();
          const scoreText = scoreResult.choices?.[0]?.message?.content || "";
          const jsonMatch = scoreText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            qualityScore = JSON.parse(jsonMatch[0]);
            const total = (qualityScore!.curiosity || 0) + (qualityScore!.human_tone || 0) + (qualityScore!.spam_risk || 0) + (qualityScore!.reply_likelihood || 0);
            const hasGroundingViolation = (qualityScore as any)?.grounding_violation === true;
            console.log(`[ai_task] Quality score: ${total}/40 (C:${qualityScore!.curiosity} H:${qualityScore!.human_tone} S:${qualityScore!.spam_risk} R:${qualityScore!.reply_likelihood})${hasGroundingViolation ? " [GROUNDING VIOLATION]" : ""}`);

            // Trigger regeneration if quality is low OR grounding failed
            const needsRegen = total < QUALITY_THRESHOLD || groundingFailed || hasGroundingViolation;
            if (needsRegen) {
              const reason = groundingFailed || hasGroundingViolation ? "grounding violation" : `low score (${total})`;
              console.log(`[ai_task] Regenerating: ${reason}. Using neutral_observation framework...`);
              const regenPromptParts = [...promptParts];
              const safeBlock = getEmailFrameworkBlock("neutral_observation");
              if (emailFrameworkBlock) {
                const idx = regenPromptParts.indexOf(emailFrameworkBlock);
                if (idx >= 0) regenPromptParts[idx] = safeBlock;
                else regenPromptParts.splice(regenPromptParts.length - 1, 0, safeBlock);
              } else {
                regenPromptParts.splice(regenPromptParts.length - 1, 0, safeBlock);
              }
              // Add explicit anti-hallucination instruction for regen
              regenPromptParts.splice(regenPromptParts.length - 1, 0, 
                "=== REGENERATION INSTRUCTION ===\nThe previous attempt failed grounding validation. Write a SAFER email:\n- Use ONLY facts from Lead Context (Section B)\n- Ask a neutral question about their role or company\n- Do NOT reference seller products or assume pain points\n- If unsure, keep it ultra-short: one observation + one question"
              );

              const regenResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model,
                  messages: [
                    { role: "system", content: `${SYSTEM_GLOBAL_PROMPT}\n\nCurrent date: ${new Date().toISOString().split('T')[0]}` },
                    { role: "user", content: regenPromptParts.join("\n\n") },
                  ],
                }),
              });

              if (regenResponse.ok) {
                const regenResult = await regenResponse.json();
                let regenContent = regenResult.choices?.[0]?.message?.content || "";
                regenContent = stripLeakedReasoning(regenContent);
                if (regenContent) {
                  regenerated_outbound = true;
                  selectedFramework = "neutral_observation" as any;
                  // Re-score
                  const rescore = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                    method: "POST",
                    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "system", content: QUALITY_SCORER_PROMPT }, { role: "user", content: regenContent }] }),
                  });
                  if (rescore.ok) {
                    const rescoreResult = await rescore.json();
                    const rescoreText = rescoreResult.choices?.[0]?.message?.content || "";
                    const rescoreMatch = rescoreText.match(/\{[\s\S]*\}/);
                    if (rescoreMatch) qualityScore = JSON.parse(rescoreMatch[0]);
                  }

                  // Log diversity for regenerated content
                  if (resolvedWorkspaceId && OUTREACH_TASKS.has(task)) {
                    try {
                      const classifyResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                        method: "POST",
                        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: CLASSIFY_MESSAGE_PROMPT + regenContent }] }),
                      });
                      if (classifyResponse.ok) {
                        const classifyResult = await classifyResponse.json();
                        const classifyText = classifyResult.choices?.[0]?.message?.content || "";
                        const classifyMatch = classifyText.match(/\{[\s\S]*\}/);
                        if (classifyMatch) {
                          const classification = JSON.parse(classifyMatch[0]);
                          const logClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
                          await logClient.from("message_generation_log").insert({
                            workspace_id: resolvedWorkspaceId, lead_id: String(payload.lead_id),
                            campaign_id: payload?.campaign_id ? String(payload.campaign_id) : null,
                            task_type: task, channel: resolvedChannel, sequence_step: sequenceStep,
                            generated_message: regenContent.slice(0, 2000),
                            opening_type: classification.opening_type || "question",
                            primary_angle: classification.primary_angle || "general",
                            secondary_angle: classification.secondary_angle || null,
                            cta_type: classification.cta_type || "quick_question",
                            tone: classification.tone || "professional",
                            kb_chunk_ids: kbResult.chunkIds.length > 0 ? kbResult.chunkIds : null,
                          });
                        }
                      }
                    } catch (logErr) { console.error("[ai_task] Diversity log failed:", logErr); }
                  }

                  const responsePayload: Record<string, unknown> = {
                    ok: true, content: regenContent,
                    quality_score: qualityScore, regenerated: true, framework_used: selectedFramework,
                  };
                  return new Response(JSON.stringify(responsePayload), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                }
              }
            }
          }
        }
      } catch (scoreErr) {
        console.error("[ai_task] Quality scoring failed:", scoreErr);
      }
    }

    // Log message diversity (non-regenerated path)
    if (resolvedWorkspaceId && OUTREACH_TASKS.has(task) && payload?.lead_id) {
      try {
        const classifyResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: CLASSIFY_MESSAGE_PROMPT + content }] }),
        });
        if (classifyResponse.ok) {
          const classifyResult = await classifyResponse.json();
          const classifyText = classifyResult.choices?.[0]?.message?.content || "";
          const classifyMatch = classifyText.match(/\{[\s\S]*\}/);
          if (classifyMatch) {
            const classification = JSON.parse(classifyMatch[0]);
            const logClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
            await logClient.from("message_generation_log").insert({
              workspace_id: resolvedWorkspaceId, lead_id: String(payload.lead_id),
              campaign_id: payload?.campaign_id ? String(payload.campaign_id) : null,
              task_type: task, channel: resolvedChannel, sequence_step: sequenceStep,
              generated_message: content.slice(0, 2000),
              opening_type: classification.opening_type || "question",
              primary_angle: classification.primary_angle || "general",
              secondary_angle: classification.secondary_angle || null,
              cta_type: classification.cta_type || "quick_question",
              tone: classification.tone || "professional",
              kb_chunk_ids: kbResult.chunkIds.length > 0 ? kbResult.chunkIds : null,
            });
            console.log(`[ai_task] ✅ Logged diversity: ${classification.opening_type}/${classification.primary_angle}/${classification.cta_type}`);
          }
        }
      } catch (logErr) { console.error("[ai_task] Diversity log failed:", logErr); }
    }

    const responsePayload: Record<string, unknown> = { ok: true, content };
    if (qualityScore) responsePayload.quality_score = qualityScore;
    if (regenerated || regenerated_outbound) responsePayload.regenerated = true;
    if (selectedFramework) responsePayload.framework_used = selectedFramework;
    if (kbResult.chunkIds.length > 0) responsePayload.kb_chunk_ids = kbResult.chunkIds;
    if (offerResult?.recommended) {
      responsePayload.offer = {
        offer_key: offerResult.recommended.offer_key,
        offer_name: offerResult.recommended.offer_name,
        link_url: offerResult.recommended.link_url,
        cta_type: offerResult.recommended.cta_type,
        match_reason: offerResult.recommended.match_reason,
        score: offerResult.recommended.score,
      };
    }
    if (commercialDecision && commercialDecision.detected_objection_classes.length > 0) {
      responsePayload.decision = {
        detected_objection_classes: commercialDecision.detected_objection_classes,
        detected_commercial_intent: commercialDecision.detected_commercial_intent,
        response_strategy: commercialDecision.response_strategy,
        proof_strategy: commercialDecision.proof_strategy,
        cta_strategy: commercialDecision.cta_strategy,
        confidence: commercialDecision.confidence,
      };
    }
    if (resolvedStagePolicy) {
      responsePayload.stage_policy = {
        effective_stage: resolvedStagePolicy.effective_stage,
        final_cta_strategy: resolvedStagePolicy.final_cta_strategy,
        final_preferred_offer_categories: resolvedStagePolicy.final_preferred_offer_categories,
        final_suppressed_offer_categories: resolvedStagePolicy.final_suppressed_offer_categories,
        stage_reasoning: resolvedStagePolicy.stage_reasoning,
        is_urgent: resolvedStagePolicy.urgency.is_urgent,
      };
    }
    if (replyObjective) {
      responsePayload.reply_objective = {
        primary: replyObjective.primary,
        secondary: replyObjective.secondary,
        reasoning: replyObjective.reasoning,
        confidence: replyObjective.confidence,
        override_source: replyObjective.override_source,
      };
    }
    if (replyEvaluation) {
      responsePayload.reply_evaluation = {
        objective_alignment_score: replyEvaluation.objective_alignment_score,
        cta_alignment_score: replyEvaluation.cta_alignment_score,
        focus_score: replyEvaluation.focus_score,
        commercial_relevance_score: replyEvaluation.commercial_relevance_score,
        policy_violations: replyEvaluation.policy_violations.map(v => ({ rule: v.rule, severity: v.severity })),
        regeneration_recommended: replyEvaluation.regeneration_recommended,
        evaluation_summary: replyEvaluation.evaluation_summary,
        dominant_layer: replyEvaluation.dominant_layer,
      };
    }
    if (dealMemory) {
      responsePayload.deal_memory = {
        momentum_state: dealMemory.momentum_state,
        handled_objections: dealMemory.handled_objections,
        unresolved_objections: dealMemory.unresolved_objections,
        shared_assets: dealMemory.shared_assets.slice(-5),
        sent_offers: dealMemory.sent_offers.slice(-5),
        recent_cta_patterns: dealMemory.recent_cta_patterns.slice(-5),
        unanswered_questions: dealMemory.unanswered_questions,
        pending_buyin_needs: dealMemory.pending_buyin_needs,
        pricing_status: dealMemory.pricing_status,
        continuity_risks: dealMemory.continuity_risks,
        ignored_cta_count: dealMemory.ignored_cta_count,
      };
    }
    // Continuity influence metadata
    if (continuityInfluence && continuityInfluence.overrides_applied.length > 0) {
      responsePayload.continuity_influence = {
        original_objective: continuityInfluence.original_objective,
        final_objective: continuityInfluence.final_objective,
        overrides_applied: continuityInfluence.overrides_applied,
        momentum_adjustment_applied: continuityInfluence.momentum_adjustment,
        repeated_cta_penalty_applied: continuityInfluence.cta_penalty_reason,
        continuity_influence_summary: continuityInfluence.overrides_applied.join("; "),
      };
    }

    // Save deal memory after generation (async, non-blocking)
    if (dealMemory && OFFER_ROUTED_TASKS.has(task)) {
      try {
        const memSaveClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const resolvedObjInReply = commercialDecision?.detected_objection_classes.filter(obj =>
          content.toLowerCase().includes(obj.replace(/_/g, " ")) ||
          (obj === "budget" && /(roi|value|investment|cost.effective|affordable)/i.test(content)) ||
          (obj === "quality_concern" && /(case study|proof|evidence|results|testimonial)/i.test(content))
        ) ?? [];
        const answeredQs = dealMemory.unanswered_questions.filter(q => {
          const words = q.split(/\s+/).slice(0, 4).join("|");
          return words.length > 5 && new RegExp(words, "i").test(content);
        });
        const updatedMemory = updateFromOutbound(
          dealMemory, content,
          resolvedStagePolicy?.final_cta_strategy ?? "soft_offer",
          offerResult?.recommended?.offer_key ?? null,
          resolvedObjInReply, answeredQs,
        );
        saveDealMemory(memSaveClient, updatedMemory);
      } catch (saveErr) {
        console.error("[ai_task] Deal memory save failed:", saveErr);
      }
    }

    return new Response(
      JSON.stringify(responsePayload),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[ai_task] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "An error occurred while processing your request", error_id: errorId }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
