/**
 * Broadened human unsubscribe detection.
 *
 * Matches common opt-out phrases people actually type:
 *   "unsubscribe", "Unsubscribe", "stop sending", "stop emailing",
 *   "remove me", "please don't email", "opt out", "take me off",
 *   "no more emails", "please stop sending mails", etc.
 *
 * The caller is responsible for the List-Unsubscribe header guard
 * (newsletters should be excluded before calling this function).
 */
export function isHumanUnsubscribeRequest(bodyLower: string): boolean {
  // Short-body standalone keyword: if the entire message (trimmed)
  // is essentially just "unsubscribe" (with optional punctuation),
  // it's unambiguously a human opt-out.
  const trimmed = bodyLower.replace(/[^a-z\s]/g, "").trim();
  if (/^unsubscribe$/.test(trimmed)) return true;

  // Phrase-level patterns
  return (
    /\bunsubscribe\b/.test(bodyLower) ||
    /\bstop\s+(sending|emailing)\b/.test(bodyLower) ||
    /\bremove\s+me\b/.test(bodyLower) ||
    /\bopt\s*out\b/.test(bodyLower) ||
    /\btake\s+me\s+off\b/.test(bodyLower) ||
    /\bno\s+more\s+emails?\b/.test(bodyLower) ||
    /\bplease\s+(don['']t|do\s+not|stop)\s+(email|contact|reach|send)\b/.test(bodyLower) ||
    /\bstop\s+contacting\b/.test(bodyLower) ||
    /\bdon['']t\s+(email|contact|send)\b/.test(bodyLower)
  );
}
