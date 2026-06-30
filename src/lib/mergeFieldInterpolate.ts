// Client-side mirror of supabase/functions/_shared/mergeFieldInterpolate.ts.
// Used by the Outreach queue preview so the rep sees the same substituted text
// the server will send. Keep the two in sync — divergence means the dialog
// preview lies to the rep about what goes out.

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

export function interpolateMergeFields(text: string, ctx: MergeContext): string {
  if (!text) return text;
  const firstName = (ctx.firstName || "").trim() || "there";
  const lastName = (ctx.lastName || "").trim() || restWords(ctx.firstName) || "";
  const company = (ctx.company || "").trim() || "your team";
  const industry = (ctx.industry || "").trim() || "your industry";
  const repFirstName = firstWord(ctx.repFirstName) || "";

  let out = text;
  out = replaceAll(out, FIRST_NAME_PATTERNS, firstName);
  out = replaceAll(out, LAST_NAME_PATTERNS, lastName);
  out = replaceAll(out, COMPANY_PATTERNS, company);
  out = replaceAll(out, INDUSTRY_PATTERNS, industry);
  if (repFirstName) out = replaceAll(out, REP_FIRST_NAME_PATTERNS, repFirstName);
  return out;
}
