// Draft post-processing for AI output — pure text helpers moved verbatim out of
// ai_task/index.ts (infra/p0-harness) so they can be unit-tested from vitest
// (src/lib/__tests__/leakStrippers.test.ts, substitutePlaceholders.test.ts).
// No behaviour change: bodies are identical to the previous inline copies.
// Pure module: no Deno.*, no createClient, no import.meta.env.


// ============================================
// STRIP LEAKED REASONING FROM LLM OUTPUT
// ============================================

const SIGNOFF_WORDS = new Set([
  "best", "thanks", "cheers", "regards", "sincerely", "warmly",
  "kindly", "respectfully", "yours", "truly",
]);

const greetingLineRe = /^(?:Subject:|(?:Hi|Hey|Hello|Dear|Thank you)\s+(?:[\p{L}\p{N}]|\{FirstName\}|\[(?:First\s*)?Name\])[^\n]{0,80}|[\p{Lu}][\p{Ll}]{1,20},)\s*$/iu;
const selfCheckLineRe = /^(?:[-*•]\s*)?(?:\*\*)?\s*(?:Word count(?: check)?|All instructions|Initial sentence|One value point|Clear CTA|Constraint check|Output check|Final check|Compliance check|The email\b|This is under\b|All constraints\b|I (?:have|followed|checked)\b)/i;

const isRealGreetingLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!greetingLineRe.test(trimmed)) return false;
  const m = trimmed.match(/^([A-Za-z]+),\s*$/);
  if (m && SIGNOFF_WORDS.has(m[1].toLowerCase())) return false;
  return true;
};

const looksLikeCompleteEmail = (text: string): boolean =>
  text.trim().length >= 40 && /^(?:Subject:|Hi\s+(?:[\p{L}\p{N}]|\{FirstName\}|\[(?:First\s*)?Name\])|Hey\s+(?:[\p{L}\p{N}]|\{FirstName\}|\[(?:First\s*)?Name\])|Hello\s+(?:[\p{L}\p{N}]|\{FirstName\}|\[(?:First\s*)?Name\])|Dear\s+(?:[\p{L}\p{N}]|\{FirstName\}|\[(?:First\s*)?Name\])|Thank you|[\p{Lu}][\p{Ll}]{1,20},)/iu.test(text.trim()) && /[.!?]/.test(text);

export function stripValidationNoiseLines(text: string): string {
  return (text || "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (selfCheckLineRe.test(trimmed)) return false;
      return !/^(?:[-*•]\s*)?(?:\*\*)?\s*(?:INTERNAL\s+REASONING|INTERNAL\s+REFLECTION|INTERNAL\s+ANALYSIS|CHAIN[\s-]?OF[\s-]?THOUGHT|Reasoning|Analysis|Plan|Notes?)\b/i.test(trimmed);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function getInboundWarmIntroViolation(content: string, payload: Record<string, unknown>): string | null {
  const text = (content || "").trim();
  if (!text) return "empty inbound response";
  const meetingLink = String(payload.meeting_link || "").trim();
  if (meetingLink && !text.includes(meetingLink)) return "missing meeting link";
  if (/biggest\s+challenge|how\s+are\s+you\s+(?:handling|approaching)|what\s+challenge|what\s+are\s+you\s+using/i.test(text)) {
    return "cold discovery question in inbound response";
  }
  if (!/(book|schedule|chat|call|meet|availability|available)/i.test(text)) return "missing meeting CTA";
  return null;
}

export function getLeadFirstNameFromContext(leadContext?: string): string | null {
  const rawName = leadContext?.match(/^Name:\s*(.+)$/m)?.[1]?.trim();
  if (!rawName) return null;

  const candidate = rawName
    .replace(/<[^>]+>/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]{1,}/u)?.[0]
    ?.replace(/[.,;:!?]+$/u, "");

  if (!candidate || /^(?:unknown|none|null|n\/a)$/i.test(candidate)) return null;
  return candidate;
}

export function getRepFirstNameFromContext(repContext?: string): string | null {
  if (!repContext) return null;
  const raw = repContext.match(/Sender Name:\s*(.+)/i)?.[1]?.trim();
  if (!raw) return null;
  const candidate = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .match(/[\p{L}][\p{L}'’.-]{1,}/u)?.[0]
    ?.replace(/[.,;:!?]+$/u, "");
  if (!candidate || /^(?:unknown|none|null|n\/a|sales|rep)$/i.test(candidate)) return null;
  return candidate;
}

export function substitutePlaceholders(
  text: string,
  leadFirst: string | null,
  repFirst: string | null,
  meetingLink: string | null,
): string {
  let out = text;
  if (leadFirst) {
    out = out.replace(/\[(?:First\s*Name|Name|Lead'?s?\s*(?:First\s*)?Name|Prospect(?:'?s?\s*First)?\s*Name)\]/gi, leadFirst);
    out = out.replace(/\{(?:First\s*Name|Name|Lead'?s?\s*(?:First\s*)?Name)\}/gi, leadFirst);
  }
  if (repFirst) {
    out = out.replace(/\[(?:Rep'?s?\s*(?:First\s*)?Name|Your\s*Name|Sender\s*Name|My\s*Name|Sales\s*Rep)\]/gi, repFirst);
    out = out.replace(/\{(?:Rep'?s?\s*(?:First\s*)?Name|Your\s*Name|Sender\s*Name)\}/gi, repFirst);
  }
  if (meetingLink) {
    out = out.replace(/\[(?:Meeting\s*Link|Calendar\s*Link|Booking\s*Link)\]/gi, meetingLink);
  }
  out = out.replace(/\[(?:Your\s*Company|Sender\s*Company|Our\s*Company)\]/gi, "our team");
  return out;
}

export function normalizeCampaignTemplatePlaceholders(text: string): string {
  return text
    .replace(/\[(?:First\s*Name|Name|Lead'?s?\s*(?:First\s*)?Name|Prospect(?:'?s?\s*First)?\s*Name)\]/gi, "{FirstName}")
    .replace(/\{(?:First\s+Name|Lead'?s?\s*(?:First\s*)?Name|Prospect(?:'?s?\s*First)?\s*Name)\}/gi, "{FirstName}")
    .replace(/\[(?:Company|Company\s*Name|Unknown\s*Company)\]/gi, "{Company}")
    .replace(/\{(?:Company\s+Name|Unknown\s*Company)\}/gi, "{Company}")
    .replace(/\[(?:Rep'?s?\s*(?:First\s*)?Name|Your\s*Name|Sender\s*Name|My\s*Name|Sales\s*Rep)\]/gi, "{RepFirstName}")
    .replace(/\{(?:Rep'?s?\s*(?:First\s*)?Name|Your\s*Name|Sender\s*Name|My\s*Name|Sales\s*Rep)\}/gi, "{RepFirstName}")
    .replace(/\[(?:Your\s*Company|Sender\s*Company|Our\s*Company)\]/gi, "our team")
    .replace(/\[(?:common|specific|relevant|insert|industry|persona|prospect|lead|customer|company|role)[^\]]{0,80}\]/gi, "a relevant priority");
}

export function stripSelfChecksAndDuplicateBodies(text: string): string {
  const lines = text.split("\n");
  const markerIdx = lines.findIndex((line) => selfCheckLineRe.test(line.trim()));
  if (markerIdx >= 0) {
    for (let i = lines.length - 1; i > markerIdx; i--) {
      if (isRealGreetingLine(lines[i])) {
        const after = lines.slice(i).join("\n").trim();
        if (looksLikeCompleteEmail(after)) return after;
      }
    }
    const before = lines.slice(0, markerIdx).join("\n").trim();
    if (looksLikeCompleteEmail(before)) return before;
    return before;
  }
  return text.trim();
}

/**
 * Robustly removes any internal reasoning/reflection/analysis/self-check blocks
 * that the LLM may have leaked before, after, or between email bodies.
 */
export function stripLeakedReasoning(text: string): string {
  if (!text) return text;
  text = stripSelfChecksAndDuplicateBodies(text);

  // Reasoning header markers (case-insensitive). May appear with optional
  // parenthetical e.g. "INTERNAL REASONING (DO NOT SHOW THIS TO USER)".
  const reasoningHeaderRe = /(?:^|\n)\s*(?:INTERNAL\s+REASONING|INTERNAL\s+REFLECTION|INTERNAL\s+ANALYSIS|CHAIN[\s-]?OF[\s-]?THOUGHT)\b[^\n]*\n/i;

  const isRealGreeting = (line: string): boolean => {
    const trimmed = line.trim();
    if (!greetingLineRe.test(trimmed)) return false;
    // Reject if this is a sign-off word followed by a comma
    const m = trimmed.match(/^([A-Za-z]+),\s*$/);
    if (m && SIGNOFF_WORDS.has(m[1].toLowerCase())) return false;
    return true;
  };

  if (reasoningHeaderRe.test(text)) {
    const headerMatch = text.match(reasoningHeaderRe);
    if (headerMatch && headerMatch.index !== undefined) {
      const headerStart = headerMatch.index;
      const afterHeader = text.substring(headerStart);

      // Look for the LAST real greeting line AFTER the reasoning header.
      const lines = text.split("\n");
      let lastGreetingLineIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (isRealGreeting(trimmed)) {
          const charsBefore = lines.slice(0, i).join("\n").length;
          if (charsBefore >= headerStart) {
            lastGreetingLineIdx = i;
            break;
          }
        }
      }

      if (lastGreetingLineIdx >= 0) {
          const result = stripValidationNoiseLines(lines.slice(lastGreetingLineIdx).join("\n"));
        // Sanity-check: real email has greeting + body + sign-off, ≥40 chars
        // and contains either a sentence-ending punctuation or a sign-off line.
        if (result.length >= 40 && /[.!?]/.test(result)) {
          return result;
        }
      }

      // Fallback: scan forward from the header for any greeting (not sign-off)
      const fwdGreetingRe = /\n((?:Subject:|Hi|Hey|Hello|Dear|Thank you)\s+[^\n]*)/i;
      const fwd = afterHeader.match(fwdGreetingRe);
      if (fwd && fwd.index !== undefined) {
        const result = stripValidationNoiseLines(afterHeader.substring(fwd.index));
        if (result.length >= 40 && /[.!?]/.test(result)) return result;
      }

      // Last resort: keep text BEFORE the reasoning header if it looks complete.
      const before = text.substring(0, headerStart).trim();
      if (before.length >= 40 && /^(?:Hi|Hey|Hello|Dear|Subject:)/i.test(before) && /[.!?]/.test(before)) {
        return before;
      }
      // Nothing salvageable — return empty so caller can regenerate.
      return "";
    }
  }

  // 2. Also strip extended chain-of-thought blocks without explicit headers
  const cotPattern = /^[\s\S]*?(?:(?:KB Insight|Constraint Check|Final plan|Let me|Okay,|Let's|I will|I need to)[^\n]*\n){3,}[\s\S]*?\n\n/im;
  const cotMatch = text.match(cotPattern);
  if (cotMatch && cotMatch[0].length > 200) {
    const remainder = text.substring(cotMatch[0].length).trim();
    if (remainder.length > 30 && /^(?:Hi|Hey|Hello|Dear|Thanks|Subject:|[A-Z][a-z]{1,20},)/i.test(remainder)) {
      return remainder;
    }
  }

  return stripValidationNoiseLines(text);
}

export function stripLeakedReasoningForTask(text: string, task: string): string {
  const cleaned = stripLeakedReasoning(text);
  if (cleaned) return cleaned;

  // stripLeakedReasoning is intentionally email-centric: after a reasoning
  // header it searches for a real greeting to recover the final email body.
  // Campaign authoring also asks for non-email artifacts (call bullets,
  // voicemail scripts, subject lines). If those leak a reasoning header, there
  // is no greeting to find, so salvage the final visible artifact instead of
  // turning a valid model response into an empty 502.
  const raw = (text || "").trim();
  if (!raw || !/(INTERNAL\s+REASONING|INTERNAL\s+REFLECTION|INTERNAL\s+ANALYSIS|CHAIN[\s-]?OF[\s-]?THOUGHT|Final\s+Output|OUTPUT)/i.test(raw)) {
    return cleaned;
  }

  const markerRe = /(?:^|\n)\s*(?:FINAL\s+OUTPUT|FINAL\s+ANSWER|OUTPUT|SUBJECT\s+LINE|TALKING\s+POINTS|VOICEMAIL(?:\s+SCRIPT)?|SMS|MESSAGE)\s*:?\s*\n?/gi;
  let start = -1;
  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(raw)) !== null) start = match.index + match[0].length;
  const tail = (start >= 0 ? raw.slice(start) : raw)
    .replace(/```(?:text|markdown)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const lines = tail.split("\n").map((line) => line.trim()).filter(Boolean);
  const visibleLines = lines.filter((line) =>
    !/^(?:INTERNAL\s+REASONING|INTERNAL\s+REFLECTION|INTERNAL\s+ANALYSIS|CHAIN[\s-]?OF[\s-]?THOUGHT|Reasoning|Analysis|Plan|Check|Notes?)\b/i.test(line) &&
    !/^(?:Here(?:'s| is)|I'?ll|I will|The final|Final answer)\b/i.test(line)
  );

  if (task === "cold_call_talking_points") {
    const bullets = visibleLines.filter((line) => /^[-*•]\s+/.test(line));
    if (bullets.length > 0) return bullets.slice(-4).join("\n");
  }

  if (task === "cold_email_subject") {
    const subject = (visibleLines[visibleLines.length - 1] || "")
      .replace(/^subject(?:\s+line)?\s*:\s*/i, "")
      .replace(/^['"“”]+|['"“”]+$/g, "")
      .trim();
    return subject.length <= 120 ? subject : subject.slice(0, 120).trim();
  }

  if (["cold_voicemail", "warm_voicemail", "voicemail_script", "call_opener", "sms_message"].includes(task)) {
    return visibleLines.slice(-4).join("\n").replace(/^(?:voicemail(?:\s+script)?|message|sms)\s*:\s*/i, "").trim();
  }

  return visibleLines.join("\n").trim();
}
