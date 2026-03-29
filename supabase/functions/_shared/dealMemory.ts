// ============================================
// DEAL MEMORY / CONTINUITY LAYER
// Tracks what already happened in a deal
// to avoid repetition and improve decisions
// ============================================

// ── Types ────────────────────────────────

export type MomentumState = "progressing" | "stalled" | "regressing" | "mixed" | "unknown";

export type PricingStatus =
  | "not_discussed"
  | "price_mentioned"
  | "quote_sent"
  | "negotiating"
  | "agreed";

export interface DealMemory {
  lead_id: string;
  workspace_id: string;
  handled_objections: string[];
  unresolved_objections: string[];
  shared_assets: string[];
  sent_offers: string[];
  recent_cta_patterns: string[];
  unanswered_questions: string[];
  pending_buyin_needs: string[];
  logistics_constraints: string[];
  pricing_status: PricingStatus;
  momentum_state: MomentumState;
  momentum_signals: MomentumSignals;
  continuity_risks: string[];
  last_outbound_cta: string | null;
  ignored_cta_count: number;
}

export interface MomentumSignals {
  recent_reply_count?: number;
  days_since_last_inbound?: number;
  consecutive_ignored_outbounds?: number;
  has_buying_signals?: boolean;
  has_new_objections?: boolean;
  stage_direction?: "up" | "down" | "flat";
}

// ── Empty memory factory ─────────────────

export function emptyMemory(leadId: string, workspaceId: string): DealMemory {
  return {
    lead_id: leadId,
    workspace_id: workspaceId,
    handled_objections: [],
    unresolved_objections: [],
    shared_assets: [],
    sent_offers: [],
    recent_cta_patterns: [],
    unanswered_questions: [],
    pending_buyin_needs: [],
    logistics_constraints: [],
    pricing_status: "not_discussed",
    momentum_state: "unknown",
    momentum_signals: {},
    continuity_risks: [],
    last_outbound_cta: null,
    ignored_cta_count: 0,
  };
}

// ── Load memory from DB ──────────────────

export async function loadDealMemory(
  supabaseClient: { from: (table: string) => any },
  leadId: string,
  workspaceId: string,
): Promise<DealMemory> {
  try {
    const { data, error } = await supabaseClient
      .from("deal_memory")
      .select("*")
      .eq("lead_id", leadId)
      .maybeSingle();

    if (error || !data) {
      // No existing memory — bootstrap from lead_intelligence
      return seedFromIntelligence(supabaseClient, leadId, workspaceId);
    }

    return {
      lead_id: data.lead_id,
      workspace_id: data.workspace_id,
      handled_objections: data.handled_objections ?? [],
      unresolved_objections: data.unresolved_objections ?? [],
      shared_assets: data.shared_assets ?? [],
      sent_offers: data.sent_offers ?? [],
      recent_cta_patterns: data.recent_cta_patterns ?? [],
      unanswered_questions: data.unanswered_questions ?? [],
      pending_buyin_needs: data.pending_buyin_needs ?? [],
      logistics_constraints: data.logistics_constraints ?? [],
      pricing_status: (data.pricing_status as PricingStatus) ?? "not_discussed",
      momentum_state: (data.momentum_state as MomentumState) ?? "unknown",
      momentum_signals: (data.momentum_signals as MomentumSignals) ?? {},
      continuity_risks: data.continuity_risks ?? [],
      last_outbound_cta: data.last_outbound_cta ?? null,
      ignored_cta_count: data.ignored_cta_count ?? 0,
    };
  } catch (err) {
    console.error("[dealMemory] Load failed:", err);
    return emptyMemory(leadId, workspaceId);
  }
}

// ── Seed from lead_intelligence on first load ──

async function seedFromIntelligence(
  supabaseClient: { from: (table: string) => any },
  leadId: string,
  workspaceId: string,
): Promise<DealMemory> {
  const memory = emptyMemory(leadId, workspaceId);
  try {
    const { data: intel } = await supabaseClient
      .from("lead_intelligence")
      .select("objections_json, buying_signals_json")
      .eq("lead_id", leadId)
      .maybeSingle();

    if (intel?.objections_json && Array.isArray(intel.objections_json)) {
      const objTexts = (intel.objections_json as any[])
        .map((o: any) => typeof o === "string" ? o : o.text || o.description || "")
        .filter(Boolean);
      memory.unresolved_objections = dedupeStrings(objTexts);
      console.log(`[dealMemory] Seeded ${memory.unresolved_objections.length} unresolved objections from lead_intelligence`);
    }
  } catch (err) {
    console.error("[dealMemory] Seed from intelligence failed:", err);
  }
  return memory;
}

// ── Lightweight outbound-only update for non-ai_task send paths ──

export function updateFromOutboundLite(
  memory: DealMemory,
  bodyText: string,
  subject: string,
): DealMemory {
  const m = { ...memory };

  // Track CTA patterns from content heuristics
  let detectedCta = "soft_offer";
  if (/\b(book|schedule|set up|arrange)\b.{0,30}\b(call|meeting|demo|time|slot)\b/i.test(bodyText)) detectedCta = "meeting_request";
  else if (/\b(sign|commit|confirm|finalize|proceed|go ahead)\b/i.test(bodyText)) detectedCta = "commitment";
  else if (/\b(check.{0,10}(in|back)|circle back|follow.{0,5}up|touch base)\b/i.test(bodyText)) detectedCta = "timing_check";
  else if (/\b(quick question|curious|wondering)\b/i.test(bodyText)) detectedCta = "quick_question";

  m.recent_cta_patterns = capArray([...m.recent_cta_patterns, detectedCta], 10);
  m.last_outbound_cta = detectedCta;

  // Track shared assets
  const assetPatterns = bodyText.match(/(?:case study|one[- ]pager|guide|whitepaper|pdf|doc|presentation|deck|roi calculator|summary)/gi) || [];
  for (const asset of assetPatterns) {
    const normalized = asset.toLowerCase().replace(/\s+/g, "_");
    if (!m.shared_assets.includes(normalized)) {
      m.shared_assets = capArray([...m.shared_assets, normalized], 20);
    }
  }

  // Pricing status from outbound
  if (/quote|proposal|pricing (details|breakdown|sheet)/i.test(bodyText)) {
    if (m.pricing_status === "price_mentioned") m.pricing_status = "quote_sent";
  }

  // If this is a follow-up with no reply, increment ignored CTA count
  // (conservative: only increment if we had a previous outbound CTA)
  if (m.last_outbound_cta && m.recent_cta_patterns.length > 1) {
    m.ignored_cta_count = (m.ignored_cta_count || 0) + 1;
  }

  m.last_updated_at = new Date().toISOString();
  return m;
}

// ── Reconcile objections with canonical lead_intelligence ──

export function reconcileObjections(
  memory: DealMemory,
  canonicalObjections: string[],
): DealMemory {
  const m = { ...memory };

  // Canonical objections from lead_intelligence are the extracted set.
  // dealt_memory tracks which are handled vs unresolved.
  // Any canonical objection NOT in handled should be unresolved.
  // Any handled objection NOT in canonical can stay handled (was resolved).
  for (const obj of canonicalObjections) {
    if (!m.handled_objections.includes(obj) && !m.unresolved_objections.includes(obj)) {
      m.unresolved_objections = dedupeStrings([...m.unresolved_objections, obj]);
    }
  }

  // Remove unresolved objections that are no longer in canonical AND were not
  // detected by the runtime classifier (they may have been resolved upstream)
  // We keep them — better to be cautious. Only handled promotion removes them.

  return m;
}

// ── Save memory to DB (upsert) ───────────

export async function saveDealMemory(
  supabaseClient: { from: (table: string) => any },
  memory: DealMemory,
): Promise<void> {
  try {
    await supabaseClient.from("deal_memory").upsert({
      lead_id: memory.lead_id,
      workspace_id: memory.workspace_id,
      handled_objections: memory.handled_objections,
      unresolved_objections: memory.unresolved_objections,
      shared_assets: memory.shared_assets,
      sent_offers: memory.sent_offers,
      recent_cta_patterns: capArray(memory.recent_cta_patterns, 10),
      unanswered_questions: memory.unanswered_questions,
      pending_buyin_needs: memory.pending_buyin_needs,
      logistics_constraints: memory.logistics_constraints,
      pricing_status: memory.pricing_status,
      momentum_state: memory.momentum_state,
      momentum_signals: memory.momentum_signals,
      continuity_risks: memory.continuity_risks,
      last_outbound_cta: memory.last_outbound_cta,
      ignored_cta_count: memory.ignored_cta_count,
      last_updated_at: new Date().toISOString(),
    }, { onConflict: "lead_id" });
  } catch (err) {
    console.error("[dealMemory] Save failed:", err);
  }
}

// ── Update memory from inbound message ───

export function updateFromInbound(
  memory: DealMemory,
  inboundText: string,
  detectedObjections: string[],
  commercialIntent: string,
): DealMemory {
  const m = { ...memory };

  // Extract questions from inbound
  const questions = extractQuestions(inboundText);
  if (questions.length > 0) {
    m.unanswered_questions = dedupeStrings([...m.unanswered_questions, ...questions]);
  }

  // Track new objections
  for (const obj of detectedObjections) {
    if (!m.handled_objections.includes(obj) && !m.unresolved_objections.includes(obj)) {
      m.unresolved_objections = dedupeStrings([...m.unresolved_objections, obj]);
    }
  }

  // Internal buy-in signals
  if (/(?:my |the )?(?:boss|manager|team|board|cfo|ceo|director|vp)|approv|sign.?off|buy.?in|stakeholder/i.test(inboundText)) {
    const need = "internal_approval_pending";
    if (!m.pending_buyin_needs.includes(need)) {
      m.pending_buyin_needs = [...m.pending_buyin_needs, need];
    }
  }

  // Logistics constraints
  const logisticsMatch = inboundText.match(/(?:need|require|must).{0,50}(?:by|before|within|deadline|asap)/i);
  if (logisticsMatch) {
    const constraint = logisticsMatch[0].slice(0, 80);
    if (!m.logistics_constraints.some(c => c.includes(constraint.slice(0, 30)))) {
      m.logistics_constraints = capArray([...m.logistics_constraints, constraint], 5);
    }
  }

  // Pricing status advancement
  if (/pric|cost|budget|quote|proposal|invest/i.test(inboundText)) {
    if (m.pricing_status === "not_discussed") m.pricing_status = "price_mentioned";
  }
  if (/accept|agree|go ahead|proceed|sounds good.*price|works for us/i.test(inboundText)) {
    m.pricing_status = "agreed";
  }

  // If prospect replies, they didn't ignore the last CTA
  if (m.last_outbound_cta) {
    m.ignored_cta_count = 0;
  }

  return m;
}

// ── Update memory from generated outbound ─

export function updateFromOutbound(
  memory: DealMemory,
  outboundContent: string,
  ctaStrategy: string,
  selectedOfferKey: string | null,
  resolvedObjections: string[],
  answeredQuestions: string[],
): DealMemory {
  const m = { ...memory };

  // Track CTA pattern
  m.recent_cta_patterns = capArray([...m.recent_cta_patterns, ctaStrategy], 10);
  m.last_outbound_cta = ctaStrategy;

  // Track shared assets
  const assetPatterns = outboundContent.match(/(?:case study|one[- ]pager|guide|whitepaper|pdf|doc|presentation|deck|roi calculator|summary)/gi) || [];
  for (const asset of assetPatterns) {
    const normalized = asset.toLowerCase().replace(/\s+/g, "_");
    if (!m.shared_assets.includes(normalized)) {
      m.shared_assets = capArray([...m.shared_assets, normalized], 20);
    }
  }

  // Track sent offers
  if (selectedOfferKey && !m.sent_offers.includes(selectedOfferKey)) {
    m.sent_offers = capArray([...m.sent_offers, selectedOfferKey], 15);
  }

  // Move resolved objections
  for (const obj of resolvedObjections) {
    if (m.unresolved_objections.includes(obj)) {
      m.unresolved_objections = m.unresolved_objections.filter(o => o !== obj);
      if (!m.handled_objections.includes(obj)) {
        m.handled_objections = [...m.handled_objections, obj];
      }
    }
  }

  // Remove answered questions
  for (const q of answeredQuestions) {
    m.unanswered_questions = m.unanswered_questions.filter(uq => !uq.includes(q) && !q.includes(uq));
  }

  // Pricing status from outbound
  if (/quote|proposal|pricing (details|breakdown|sheet)/i.test(outboundContent)) {
    if (m.pricing_status === "price_mentioned") m.pricing_status = "quote_sent";
  }

  return m;
}

// ── Compute momentum ────────────────────

export function computeMomentum(
  memory: DealMemory,
  daysSinceLastInbound: number | null,
  recentReplyCount: number,
  hasBuyingSignals: boolean,
  hasNewObjections: boolean,
): DealMemory {
  const m = { ...memory };

  const signals: MomentumSignals = {
    recent_reply_count: recentReplyCount,
    days_since_last_inbound: daysSinceLastInbound ?? undefined,
    consecutive_ignored_outbounds: m.ignored_cta_count,
    has_buying_signals: hasBuyingSignals,
    has_new_objections: hasNewObjections,
  };
  m.momentum_signals = signals;

  // Determine momentum state
  const stalled = (daysSinceLastInbound !== null && daysSinceLastInbound > 7) || m.ignored_cta_count >= 3;
  const regressing = m.ignored_cta_count >= 4 || (daysSinceLastInbound !== null && daysSinceLastInbound > 14);
  const progressing = recentReplyCount >= 2 && hasBuyingSignals && !stalled;
  const mixed = hasBuyingSignals && hasNewObjections;

  if (regressing) m.momentum_state = "regressing";
  else if (stalled) m.momentum_state = "stalled";
  else if (mixed) m.momentum_state = "mixed";
  else if (progressing) m.momentum_state = "progressing";
  else m.momentum_state = "unknown";

  // Compute continuity risks
  const risks: string[] = [];
  if (m.unanswered_questions.length > 0) risks.push("unanswered_questions");
  if (m.unresolved_objections.length > 0) risks.push("unresolved_objections");
  if (m.pending_buyin_needs.length > 0) risks.push("pending_internal_buyin");
  if (m.ignored_cta_count >= 2) risks.push("cta_fatigue");
  if (m.momentum_state === "stalled") risks.push("deal_stalled");
  if (m.momentum_state === "regressing") risks.push("deal_regressing");

  // Check CTA repetition
  const last3 = m.recent_cta_patterns.slice(-3);
  if (last3.length === 3 && last3[0] === last3[1] && last3[1] === last3[2]) {
    risks.push("repeated_cta_pattern");
  }

  m.continuity_risks = risks;
  return m;
}

// ── Format for prompt injection ──────────

export function formatDealMemoryBlock(memory: DealMemory): string {
  const parts: string[] = [
    "=== DEAL MEMORY (internal — do NOT share with customer) ===",
  ];

  if (memory.momentum_state !== "unknown") {
    parts.push(`Deal Momentum: ${memory.momentum_state.toUpperCase()}`);
  }

  if (memory.handled_objections.length > 0) {
    parts.push(`Already Handled Objections: ${memory.handled_objections.join(", ")}`);
    parts.push("→ Do NOT re-handle these unless the prospect raises them again.");
  }

  if (memory.unresolved_objections.length > 0) {
    parts.push(`Unresolved Objections: ${memory.unresolved_objections.join(", ")}`);
    parts.push("→ Prioritize addressing these if relevant to this reply.");
  }

  if (memory.unanswered_questions.length > 0) {
    parts.push(`Unanswered Prospect Questions:`);
    for (const q of memory.unanswered_questions.slice(0, 5)) {
      parts.push(`  - ${q}`);
    }
    parts.push("→ Prioritize answering these.");
  }

  if (memory.shared_assets.length > 0) {
    parts.push(`Already Shared Assets: ${memory.shared_assets.join(", ")}`);
    parts.push("→ Do NOT re-share the same asset unless the prospect explicitly asks.");
  }

  if (memory.sent_offers.length > 0) {
    parts.push(`Already Sent Offers: ${memory.sent_offers.join(", ")}`);
    parts.push("→ Recommend different offers or reference these as context.");
  }

  if (memory.continuity_risks.length > 0) {
    parts.push(`Continuity Risks: ${memory.continuity_risks.join(", ")}`);
  }

  if (memory.recent_cta_patterns.length > 0) {
    const last3 = memory.recent_cta_patterns.slice(-3);
    parts.push(`Recent CTA Patterns: ${last3.join(" → ")}`);
    if (last3.length >= 2 && last3[last3.length - 1] === last3[last3.length - 2]) {
      parts.push("→ VARY the CTA pattern — the same one was used consecutively.");
    }
  }

  if (memory.pending_buyin_needs.length > 0) {
    parts.push(`Pending Internal Buy-in: ${memory.pending_buyin_needs.join(", ")}`);
    parts.push("→ Prefer shareable/forwardable content until resolved.");
  }

  if (memory.logistics_constraints.length > 0) {
    parts.push(`Known Logistics Constraints: ${memory.logistics_constraints.join("; ")}`);
  }

  if (memory.pricing_status !== "not_discussed") {
    parts.push(`Pricing Status: ${memory.pricing_status}`);
  }

  if (memory.momentum_state === "stalled" || memory.momentum_state === "regressing") {
    parts.push("");
    parts.push("⚠️ DEAL IS " + memory.momentum_state.toUpperCase());
    parts.push("- Do NOT pretend the deal is progressing normally");
    parts.push("- Consider a fresh angle or re-engagement approach");
    parts.push("- Avoid repeating previous CTAs that were ignored");
  }

  parts.push("=== END DEAL MEMORY ===");
  return parts.join("\n");
}

// ── Continuity rules for objective selection ──

export interface ContinuityHints {
  should_vary_cta: boolean;
  preferred_cta_override: string | null;
  suppress_repeated_assets: string[];
  suppress_repeated_offers: string[];
  prioritize_unanswered: boolean;
  prioritize_buyin: boolean;
  is_stalled: boolean;
  is_regressing: boolean;
}

export function getContinuityHints(memory: DealMemory): ContinuityHints {
  const last3 = memory.recent_cta_patterns.slice(-3);
  const repeatedCta = last3.length >= 2 && last3[last3.length - 1] === last3[last3.length - 2];

  // Suggest an alternative CTA if repeated
  let preferredCtaOverride: string | null = null;
  if (repeatedCta && last3.length > 0) {
    const lastCta = last3[last3.length - 1];
    const alternatives: Record<string, string> = {
      "soft_offer": "proof_based",
      "meeting_request": "soft_offer",
      "direct_offer": "timing_check",
      "commitment": "easy_forward",
      "quick_question": "soft_offer",
    };
    preferredCtaOverride = alternatives[lastCta] ?? null;
  }

  return {
    should_vary_cta: repeatedCta,
    preferred_cta_override: preferredCtaOverride,
    suppress_repeated_assets: memory.shared_assets,
    suppress_repeated_offers: memory.sent_offers,
    prioritize_unanswered: memory.unanswered_questions.length > 0,
    prioritize_buyin: memory.pending_buyin_needs.length > 0,
    is_stalled: memory.momentum_state === "stalled",
    is_regressing: memory.momentum_state === "regressing",
  };
}

// ── Helpers ──────────────────────────────

function extractQuestions(text: string): string[] {
  if (!text) return [];
  const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean);
  const questions: string[] = [];
  for (const s of sentences) {
    if (s.includes("?") || /^(how|what|where|when|can|does|is|do|will|could|would|are|should)\b/i.test(s)) {
      const cleaned = s.replace(/\?+$/, "").trim();
      if (cleaned.length > 10 && cleaned.length < 200) {
        questions.push(cleaned);
      }
    }
  }
  return questions.slice(0, 5);
}

export function dedupeStrings(arr: string[]): string[] {
  return [...new Set(arr)];
}

function capArray(arr: string[], max: number): string[] {
  return arr.slice(-max);
}
