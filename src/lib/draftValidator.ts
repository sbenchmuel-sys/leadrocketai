// Frontend mirror of supabase/functions/_shared/draftValidator.ts.
// Keep these two files in sync — they enforce the same send-safe contract.
// See the edge-function version for full rationale.

export type DraftKind =
  | "cold_intro"
  | "cold_followup"
  | "cold_breakup"
  | "inbound_intro"
  | "inbound_followup"
  | "nurture"
  | "reply"
  | "generic_email";

export interface ValidationContext {
  kind: DraftKind;
  lead_first_name?: string | null;
  meeting_link?: string | null;
  allow_template_placeholders?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  codes: string[];
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

const SIGNOFF_LINE_RE = /^(?:Best(?:\s+regards)?|Thanks(?:\s+(?:so\s+much|again|in\s+advance))?|Thank\s+you|Regards|Kind\s+regards|Warm\s+regards|Cheers|Sincerely|Warmly|Talk\s+soon|Speak\s+soon|All\s+the\s+best)\b[\s,!.\-–—]*$/i;

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
  const placeholderScanText = ctx.allow_template_placeholders
    ? text.replace(/\{(?:FirstName|Company|RepFirstName)\}/gi, "TemplateValue")
    : text;
  const length = text.length;

  if (length < 40) {
    errors.push("Body is empty or too short to be a real email");
    codes.push("body_too_short");
    return { ok: false, errors, codes, body_length: length };
  }

  for (const re of REASONING_MARKERS) {
    if (re.test(text)) {
      errors.push(`Leaked reasoning marker: ${re.source}`);
      codes.push("reasoning_leak");
      break;
    }
  }

  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(placeholderScanText)) {
      errors.push(`Unresolved placeholder: ${re.source}`);
      codes.push("placeholder");
      break;
    }
  }

  const firstNonEmpty = text.split("\n").find((l) => l.trim().length > 0)?.trim() || "";
  const hasGreeting = /^(?:Hi|Hey|Hello|Dear|Thank you|Thanks)\b/i.test(firstNonEmpty);
  if (!hasGreeting) {
    errors.push("Missing greeting (Hi/Hey/Hello/Dear)");
    codes.push("missing_greeting");
  } else if (ctx.lead_first_name) {
    if (!hasAddressedGreeting(firstNonEmpty)) {
      errors.push("Greeting does not address recipient");
      codes.push("greeting_unaddressed");
    }
  }

  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const lastLine = lines[lines.length - 1] || "";
  const secondLast = lines[lines.length - 2] || "";
  const hasSignOff = SIGNOFF_LINE_RE.test(secondLast) || SIGNOFF_LINE_RE.test(lastLine) ||
    /\b(?:Best|Thanks|Regards|Cheers|Sincerely)\b[,.]?\s*$/i.test(lines.slice(-3).join(" "));
  if (!hasSignOff) {
    errors.push("Missing sign-off (Best, Thanks, etc.)");
    codes.push("missing_signoff");
  }

  const middle = lines.slice(1, lines.length - 1).join(" ").trim();
  const middleCleaned = middle.replace(/^(?:Best|Thanks|Regards|Cheers|Sincerely)[,.]?\s*$/i, "").trim();
  if (middleCleaned.length < 20 || !/[.!?]/.test(middleCleaned)) {
    errors.push("No real body content between greeting and sign-off");
    codes.push("body_missing");
  }

  if (ctx.kind === "inbound_intro" || ctx.kind === "inbound_followup") {
    for (const re of COLD_DISCOVERY_PHRASES) {
      if (re.test(text)) {
        errors.push("Inbound email uses cold discovery framing");
        codes.push("inbound_cold_framing");
        break;
      }
    }
    if (!/(book|schedule|chat|call|meet|availability|available|calendar)/i.test(text)) {
      errors.push("Inbound email missing meeting CTA");
      codes.push("inbound_missing_cta");
    }
    if (ctx.meeting_link && ctx.meeting_link.trim() && !text.includes(ctx.meeting_link.trim())) {
      errors.push("Inbound email missing the provided meeting link");
      codes.push("inbound_missing_meeting_link");
    }
  }

  if (ctx.kind === "cold_breakup") {
    const hasCloseLoop = /\?/.test(text) || /(close the loop|wrap (?:this|things) up|move on|stop reaching out)/i.test(text);
    if (!hasCloseLoop) {
      errors.push("Breakup missing close-loop question");
      codes.push("breakup_missing_close");
    }
  }

  return { ok: errors.length === 0, errors, codes, body_length: length };
}

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
