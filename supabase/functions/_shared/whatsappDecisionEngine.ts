/**
 * WhatsApp Automation Decision Engine
 * 
 * Extracted from whatsapp-webhook to be reusable across
 * webhook processing, manual sends, and future channels.
 */

// ── Utility: check if acceleration window is active ──────
export function isAccelerationActive(lead: any): boolean {
  if (!lead?.acceleration_until) return false;
  return new Date(lead.acceleration_until) > new Date();
}

// ── Utility: resolve effective automation mode ────────────
export function getEffectiveMode(lead: any, workspaceSettings: any): string {
  if (isAccelerationActive(lead)) return "acceleration";
  if (lead?.automation_mode) return lead.automation_mode;
  return workspaceSettings?.default_mode ?? "suggest_only";
}

// ── Decision Engine ───────────────────────────────────────
export interface AutoSendDecision {
  allowed: boolean;
  reason: string;
}

export interface AutoSendOptions {
  effective_mode: string;
  intent: string;
  confidence: number;
  workspaceSettings: any;
  lead: any;
  message_text: string;
}

export function shouldAutoSend(opts: AutoSendOptions): AutoSendDecision {
  const { effective_mode, intent, confidence, workspaceSettings, lead, message_text } = opts;

  // Safety: too short
  if (message_text.trim().length < 3) {
    return { allowed: false, reason: "message_too_short" };
  }

  // Safety: low confidence threshold
  if (confidence < 0.70) {
    return { allowed: false, reason: "low_confidence" };
  }

  // Safety: unsubscribe intent
  if (intent === "unsubscribe") {
    return { allowed: false, reason: "unsubscribe_intent" };
  }

  // Block on keywords
  const blockedKeywords: string[] = workspaceSettings?.blocked_keywords ?? [
    "discount", "lawyer", "contract", "refund", "cancel", "compliance", "lawsuit",
  ];
  const lowerText = message_text.toLowerCase();
  const matchedKeyword = blockedKeywords.find((kw: string) => lowerText.includes(kw.toLowerCase()));
  if (matchedKeyword) {
    return { allowed: false, reason: `blocked_keyword:${matchedKeyword}` };
  }

  // Mode-specific logic
  switch (effective_mode) {
    case "manual":
    case "suggest_only":
      return { allowed: false, reason: `mode_${effective_mode}` };

    case "full_auto":
      return { allowed: true, reason: "full_auto" };

    case "acceleration":
      if (confidence >= 0.75 && !["legal", "negotiation", "complaint", "unsubscribe"].includes(intent)) {
        return { allowed: true, reason: "acceleration_mode" };
      }
      return { allowed: false, reason: "acceleration_blocked_intent_or_confidence" };

    case "hybrid": {
      const threshold = workspaceSettings?.confidence_threshold ?? 0.85;
      const allowedIntents = ["acknowledgment", "scheduling", "clarification"];
      const blockedStages: string[] = workspaceSettings?.blocked_stages ?? ["negotiation", "contract_sent"];
      if (
        confidence >= threshold &&
        allowedIntents.includes(intent) &&
        !blockedStages.includes(lead?.stage ?? "")
      ) {
        return { allowed: true, reason: "hybrid_approved" };
      }
      return { allowed: false, reason: "hybrid_policy_blocked" };
    }

    default:
      return { allowed: false, reason: "unknown_mode" };
  }
}

/** Robust JSON extractor (handles LLM markdown wrapping) */
export function extractJsonFromResponse(content: string): unknown {
  try { return JSON.parse(content); } catch { /* continue */ }

  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch { /* continue */ }

  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const slice = stripped.slice(first, last + 1);
    try { return JSON.parse(slice); } catch { /* continue */ }

    const repaired = slice
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .replace(/,(\s*[}\]])/g, "$1");
    try { return JSON.parse(repaired); } catch { /* continue */ }
  }

  throw new Error("Could not extract valid JSON from LLM response");
}
