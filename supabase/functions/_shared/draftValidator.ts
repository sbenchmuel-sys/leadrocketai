// Shared draft validator — single source of truth for what counts as a
// send-safe email body. Used by:
//   - ai_task (post-generation gate; triggers regeneration)
//   - automation-executor (pre-send gate; blocks bad cached drafts)
//   - frontend AutomationDraftPreviewDialog (mirror in src/lib/draftValidator.ts)
//
// Returning ok=false means: do NOT save, do NOT send, do NOT show.

export type DraftKind =
  | "cold_intro"           // pre_email_1_intro
  | "cold_followup"        // pre_email_2_followup, pre_email_3_followup
  | "cold_breakup"         // pre_email_4_breakup
  | "inbound_intro"        // inbound_intro
  | "inbound_followup"     // inbound_followup_1, inbound_followup_2
  | "nurture"              // nurture_email_single
  | "reply"                // reply_to_thread, post_meeting_followup_email
  | "generic_email";

export interface ValidationContext {
  kind: DraftKind;
  lead_first_name?: string | null;
  meeting_link?: string | null;   // when present, inbound emails MUST include it
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];           // human-readable
  codes: string[];            // machine-readable for logs/metrics
  body_length: number;
}

const REASONING_MARKERS = [
  /INTERNAL\s+REASONING/i,
  /INTERNAL\s+REFLECTION/i,
  /INTERNAL\s+ANALYSIS/i,
  /CHAIN[\s-]?OF[\s-]?THOUGHT/i,
  /\bWord count(?:\s*check)?\b/i,
  /\bAll instructions (?:followed|checked)\b/i,
  /\bConstraint check\b/i,
  /\bCompliance check\b/i,
  /\bFinal check\b/i,
  /\bOutput check\b/i,
  /\bI (?:have|followed|checked)\b/i,
];

const PLACEHOLDER_PATTERNS = [
  /\[Name\]/i,
  /\[First\s*Name\]/i,
  /\[Your\s*Name\]/i,
  /\[Sender\s*Name\]/i,
  /\[Rep'?s?\s*first\s*name\]/i,
  /\[Meeting\s*Link\]/i,
  /\[Calendar\s*Link\]/i,
  /\[Unknown\s*Company\]/i,
  /\[Lead'?s\s+implied\s+need\]/i,
  /\{First\s*Name\}/i,
  /\{Your\s*Name\}/i,
  /\{Sender\s*Name\}/i,
  /\{Rep'?s?\s*first\s*name\}/i,
];

const COLD_DISCOVERY_PHRASES = [
  /biggest\s+challenge/i,
  /how\s+are\s+you\s+(?:handling|approaching|managing)/i,
  /what\s+(?:is|are)\s+(?:the|your)\s+(?:biggest|main)/i,
  /what\s+challenges?\s+/i,
];

const SIGNOFF_LINE_RE = /^(?:Best|Thanks|Thank you|Regards|Kind regards|Cheers|Sincerely|Warmly)[,!.\s]?$/i;

function hasAddressedGreeting(line: string): boolean {
  const remainder = line
    .replace(/^(?:Hi|Hey|Hello|Dear|Thank you|Thanks)\b/iu, "")
    .replace(/^[\s,.:;!\-–—]+/u, "")
    .trim();

  return /[\p{L}\p{N}]{2,}/u.test(remainder);
}

export function validateDraft(body: string, ctx: ValidationContext): ValidationResult {
  const errors: string[] = [];
  const codes: string[] = [];
  const text = (body || "").trim();
  const length = text.length;

  // 1. Empty / too short
  if (length < 40) {
    errors.push("Body is empty or too short to be a real email");
    codes.push("body_too_short");
    return { ok: false, errors, codes, body_length: length };
  }

  // 2. Reasoning leaks
  for (const re of REASONING_MARKERS) {
    if (re.test(text)) {
      errors.push(`Leaked reasoning marker: ${re.source}`);
      codes.push("reasoning_leak");
      break;
    }
  }

  // 3. Placeholders
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(text)) {
      errors.push(`Unresolved placeholder: ${re.source}`);
      codes.push("placeholder");
      break;
    }
  }

  // 4. Greeting
  const firstNonEmpty = text.split("\n").find((l) => l.trim().length > 0)?.trim() || "";
  const hasGreeting = /^(?:Hi|Hey|Hello|Dear|Thank you|Thanks)\b/i.test(firstNonEmpty);
  if (!hasGreeting) {
    errors.push("Missing greeting (Hi/Hey/Hello/Dear)");
    codes.push("missing_greeting");
  } else if (ctx.lead_first_name) {
    // Greeting must address the lead (not just "Hi,")
    if (!hasAddressedGreeting(firstNonEmpty)) {
      errors.push("Greeting does not address recipient");
      codes.push("greeting_unaddressed");
    }
  }

  // 5. Sign-off + body presence
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const lastLine = lines[lines.length - 1] || "";
  const secondLast = lines[lines.length - 2] || "";
  const hasSignOff = SIGNOFF_LINE_RE.test(secondLast) || SIGNOFF_LINE_RE.test(lastLine) ||
    /\b(?:Best|Thanks|Regards|Cheers|Sincerely)\b[,.]?\s*$/i.test(lines.slice(-3).join(" "));
  if (!hasSignOff) {
    errors.push("Missing sign-off (Best, Thanks, etc.)");
    codes.push("missing_signoff");
  }

  // 6. Sign-off-only / greeting+sign-off-only (no body sentence)
  // Strip greeting + sign-off and see if anything substantive remains.
  const middle = lines.slice(1, lines.length - 1).join(" ").trim();
  const middleCleaned = middle.replace(/^(?:Best|Thanks|Regards|Cheers|Sincerely)[,.]?\s*$/i, "").trim();
  if (middleCleaned.length < 20 || !/[.!?]/.test(middleCleaned)) {
    errors.push("No real body content between greeting and sign-off");
    codes.push("body_missing");
  }

  // 7. Inbound-specific rules
  if (ctx.kind === "inbound_intro" || ctx.kind === "inbound_followup") {
    // Cold discovery question is forbidden
    for (const re of COLD_DISCOVERY_PHRASES) {
      if (re.test(text)) {
        errors.push("Inbound email uses cold discovery framing");
        codes.push("inbound_cold_framing");
        break;
      }
    }
    // Meeting CTA required
    if (!/(book|schedule|chat|call|meet|availability|available|calendar)/i.test(text)) {
      errors.push("Inbound email missing meeting CTA");
      codes.push("inbound_missing_cta");
    }
    // If a meeting link was provided, it MUST appear verbatim
    if (ctx.meeting_link && ctx.meeting_link.trim() && !text.includes(ctx.meeting_link.trim())) {
      errors.push("Inbound email missing the provided meeting link");
      codes.push("inbound_missing_meeting_link");
    }
  }

  // 8. Breakup-specific rules
  if (ctx.kind === "cold_breakup") {
    // Must have a yes/no question or close-loop phrasing
    const hasCloseLoop = /\?/.test(text) || /(close the loop|wrap (?:this|things) up|move on|stop reaching out)/i.test(text);
    if (!hasCloseLoop) {
      errors.push("Breakup missing close-loop question");
      codes.push("breakup_missing_close");
    }
  }

  return { ok: errors.length === 0, errors, codes, body_length: length };
}

/** Map an ai_task task name to a DraftKind for validation. */
export function kindFromTask(task: string): DraftKind {
  switch (task) {
    case "pre_email_1_intro":
    case "email_intro_fast":
    case "email_intro_nurture":
    case "re_engagement_intro":
      return "cold_intro";
    case "pre_email_2_followup":
    case "pre_email_3_followup":
      return "cold_followup";
    case "pre_email_4_breakup":
      return "cold_breakup";
    case "inbound_intro":
      return "inbound_intro";
    case "inbound_followup_1":
    case "inbound_followup_2":
      return "inbound_followup";
    case "nurture_email_single":
      return "nurture";
    case "reply_to_thread":
    case "post_meeting_followup_email":
    case "post_meeting_followup_personalized":
      return "reply";
    default:
      return "generic_email";
  }
}
