// ============================================================================
// Merge-field interpolation (the SINGLE renderer for campaign tokens)
//
// Templates authored in the campaign builder use canonical PascalCase tokens —
// {FirstName}, {LastName}, {Company}, {Industry}, {RepFirstName}. Without a
// shared renderer, each send path (review send, automatic executor, scheduler
// preview) had to reinvent the substitution and would leak literal "{Company}"
// to recipients if it forgot one. This module is the one place that mapping
// lives — every send path MUST call it before the wire.
//
// Behavior choices (deliberate):
//  - If a value is MISSING we substitute a neutral fallback rather than leaving
//    the literal token in the email. A rep can write "at {Company}" and trust
//    that a lead missing a company name will read "at your team", not the raw
//    token. This is the failure-mode the user actually reported.
//  - We accept loose authoring variants — bracket form ([First Name]), spaces
//    ({First Name}), lowercase ({first_name}) — so a template hand-typed in the
//    Write-my-own editor renders the same as one inserted from the toolbar.
//  - {MeetingLink} is INTENTIONALLY left alone: it is resolved per-step by
//    appendOwnerMeetingCta against the lead-owner's calendar link, which has
//    different rules (per-step toggle, owner-scoped link).
// ============================================================================

export interface MergeContext {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  industry?: string | null;
  repFirstName?: string | null;
}

const FIRST_NAME_PATTERNS = [
  /\{\s*FirstName\s*\}/gi,
  /\{\s*First[_\s]*Name\s*\}/gi,
  /\[\s*First[_\s]*Name\s*\]/gi,
  /\{\s*Lead'?s?\s*(?:First\s*)?Name\s*\}/gi,
  /\[\s*Lead'?s?\s*(?:First\s*)?Name\s*\]/gi,
  /\{\s*Prospect(?:'?s?\s*First)?\s*Name\s*\}/gi,
  /\[\s*Prospect(?:'?s?\s*First)?\s*Name\s*\]/gi,
  /\{\s*name\s*\}/gi,
  /\[\s*name\s*\]/gi,
];
const LAST_NAME_PATTERNS = [
  /\{\s*LastName\s*\}/gi,
  /\{\s*Last[_\s]*Name\s*\}/gi,
  /\[\s*Last[_\s]*Name\s*\]/gi,
];
const COMPANY_PATTERNS = [
  /\{\s*Company(?:\s*Name)?\s*\}/gi,
  /\[\s*Company(?:\s*Name)?\s*\]/gi,
  /\{\s*Unknown\s*Company\s*\}/gi,
  /\[\s*Unknown\s*Company\s*\]/gi,
];
const INDUSTRY_PATTERNS = [
  /\{\s*Industry\s*\}/gi,
  /\[\s*Industry\s*\]/gi,
];
const REP_FIRST_NAME_PATTERNS = [
  /\{\s*RepFirstName\s*\}/gi,
  /\{\s*Rep'?s?\s*(?:First\s*)?Name\s*\}/gi,
  /\[\s*Rep'?s?\s*(?:First\s*)?Name\s*\]/gi,
  /\{\s*Your\s*Name\s*\}/gi,
  /\[\s*Your\s*Name\s*\]/gi,
  /\{\s*Sender\s*Name\s*\}/gi,
  /\[\s*Sender\s*Name\s*\]/gi,
  /\{\s*Sales\s*Rep\s*\}/gi,
  /\[\s*Sales\s*Rep\s*\]/gi,
];

function replaceAll(text: string, patterns: RegExp[], value: string): string {
  let out = text;
  for (const p of patterns) out = out.replace(p, value);
  return out;
}

function firstWord(s: string | null | undefined): string {
  return (s || "").trim().split(/\s+/)[0] || "";
}

function restWords(s: string | null | undefined): string {
  const parts = (s || "").trim().split(/\s+/);
  return parts.slice(1).join(" ");
}

/**
 * Substitute every canonical merge token in `text` using `ctx`. Missing values
 * fall back to a neutral phrase so a literal "{Company}" never reaches a recipient.
 * Pure / synchronous / no I/O — safe to call on previews and sends alike.
 */
export function interpolateMergeFields(text: string, ctx: MergeContext): string {
  if (!text) return text;

  const firstName = (ctx.firstName || "").trim() || firstWord(ctx.firstName) || "there";
  const lastName = (ctx.lastName || "").trim() || restWords(ctx.firstName) || "";
  const company = (ctx.company || "").trim() || "your team";
  const industry = (ctx.industry || "").trim() || "your industry";
  const repFirstName = firstWord(ctx.repFirstName) || "";

  let out = text;
  out = replaceAll(out, FIRST_NAME_PATTERNS, firstName);
  out = replaceAll(out, LAST_NAME_PATTERNS, lastName);
  out = replaceAll(out, COMPANY_PATTERNS, company);
  out = replaceAll(out, INDUSTRY_PATTERNS, industry);
  // Rep first name LAST so a missing rep doesn't blank earlier text. If we have
  // no rep name we leave the legacy "{First Name}" leak path alone — the signature
  // block is the more reliable place to surface the sender's identity.
  if (repFirstName) {
    out = replaceAll(out, REP_FIRST_NAME_PATTERNS, repFirstName);
  }
  return out;
}
