// ============================================================================
// Email validation for cold outreach import (Outreach Unit C, PR 4)
//
// Catch malformed / syntactically-invalid addresses and obvious junk BEFORE they
// can ever be cold-emailed, and flag risky-looking ones. Used at import
// (LeadImportDialog) to show an honest heads-up, and at enrollment (never enroll
// an invalid address — fail closed). Pure + unit-testable.
//
// The regex mirrors the practical shape Zod's .email() accepts (already used in
// EditLeadDialog) — deliberately not full RFC 5322 (that admits addresses no
// real inbox uses); we want "would a mail server accept this" plus junk filters.
// ============================================================================

// One @, non-empty local + domain, a dot in the domain, no whitespace.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True if the address is syntactically sendable. */
export function isValidEmail(email: string | null | undefined): boolean {
  const e = (email || "").trim();
  if (!e || e.length > 254) return false;
  if (!EMAIL_RE.test(e)) return false;
  if (e.includes("..")) return false;               // consecutive dots
  const [local, domain] = e.split("@");
  if (!local || local.length > 64) return false;
  if (!domain) return false;
  // Validate EVERY DNS label, not just the whole domain's first/last char — otherwise
  // an invalid intermediate label (foo-.example.com, bar.-example.com) slips through.
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }
  return true;
}

// Role / placeholder local-parts and throwaway domains that shouldn't be cold-mailed.
const JUNK_LOCALPARTS = new Set([
  "test", "noreply", "no-reply", "donotreply", "do-not-reply", "example", "admin",
  "postmaster", "mailer-daemon", "abuse", "spam", "null", "none", "na", "info",
]);
const JUNK_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "test.com", "email.com", "domain.com",
  "mailinator.com", "yopmail.com", "guerrillamail.com", "10minutemail.com",
  "trashmail.com", "tempmail.com", "getnada.com", "sharklasers.com",
]);

/** True if a syntactically-valid address still looks risky/junk (worth flagging). */
export function isSuspiciousEmail(email: string | null | undefined): boolean {
  if (!isValidEmail(email)) return false; // invalid is its own category
  const e = (email as string).trim().toLowerCase();
  const [local, domain] = e.split("@");
  if (JUNK_DOMAINS.has(domain)) return true;
  if (JUNK_LOCALPARTS.has(local)) return true;
  if (/^(test|sample|fake|asdf|qwerty|aaa+)/.test(local)) return true;
  return false;
}

export type EmailClass = "valid" | "invalid" | "suspicious";

export function classifyEmail(email: string | null | undefined): EmailClass {
  if (!isValidEmail(email)) return "invalid";
  if (isSuspiciousEmail(email)) return "suspicious";
  return "valid";
}

/** Summarize a batch — used for the import heads-up. */
export function summarizeEmailQuality(emails: Array<string | null | undefined>): {
  valid: number; invalid: number; suspicious: number;
} {
  const out = { valid: 0, invalid: 0, suspicious: 0 };
  for (const e of emails) out[classifyEmail(e)]++;
  return out;
}
