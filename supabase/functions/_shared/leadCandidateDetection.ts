// Shared filter chain and helpers for the Lead Candidates detection pipeline.
// Used by detect-lead-candidates. Do not import from user-facing functions.

export const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aim.com',
  'protonmail.com', 'proton.me',
  'zoho.com',
]);

// Local-part prefixes that indicate a role/no-reply address rather than a human
const ROLE_PREFIXES = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'notifications', 'notification',
  'billing', 'payments', 'invoice', 'invoices',
  'support', 'help', 'helpdesk',
  'info', 'hello', 'contact',
  'sales', 'marketing',
  'newsletter', 'news',
  'mailer', 'mailer-daemon', 'postmaster',
  'bounces', 'bounce',
  'admin', 'noti', 'alerts', 'alert',
  'security', 'privacy',
];

// Normalize email: lowercase + strip Gmail-style plus-aliasing
export function normalizeEmail(email: string): string {
  const lower = email.toLowerCase().trim();
  const atIdx = lower.indexOf('@');
  if (atIdx < 0) return lower;
  const local = lower.slice(0, atIdx).replace(/\+.*$/, '');
  const domain = lower.slice(atIdx + 1);
  return `${local}@${domain}`;
}

export function emailDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() || '';
}

export function isRoleAddress(email: string): boolean {
  const local = email.split('@')[0].toLowerCase();
  return ROLE_PREFIXES.some(
    p => local === p || local.startsWith(`${p}-`) || local.startsWith(`${p}_`),
  );
}

export function isPersonalDomain(domain: string): boolean {
  return PERSONAL_DOMAINS.has(domain.toLowerCase());
}

// Extract email addresses from a header value like "Name <email>" or bare addresses
export function extractEmailsFromHeader(header: string): string[] {
  const results: string[] = [];
  const re = /<([^>]+@[^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    const addr = (m[1] || m[2]).toLowerCase().trim();
    if (addr) results.push(addr);
  }
  return results;
}

// Extract name from a "Display Name <email>" header value
export function extractNameFromHeader(header: string): string | null {
  const match = /^"?([^"<]+)"?\s*</.exec(header.trim());
  if (match) {
    const name = match[1].trim().replace(/"/g, '');
    return name || null;
  }
  return null;
}

export type FilterReason =
  | 'teammate'
  | 'internal_domain'
  | 'dismissed_email'
  | 'dismissed_domain'
  | 'personal_domain'
  | 'role_address'
  | 'existing_lead'
  | 'pass';

export interface FilterResult {
  pass: boolean;
  reason: FilterReason;
}

export interface WorkspaceFilterContext {
  workspaceId: string;
  // All connected rep email addresses in this workspace (lowercase)
  memberEmails: Set<string>;
  // Domains treated as internal (workspace_internal_domains + rep mailbox domains)
  internalDomains: Set<string>;
  // workspace_dismissed_emails (lowercase normalized)
  dismissedEmails: Set<string>;
  // workspace_dismissed_domains (lowercase)
  dismissedDomains: Set<string>;
  // leads.email (lowercase normalized) — already-known prospects
  existingLeadEmails: Set<string>;
  // When true, personal email domains (gmail.com, yahoo.com, etc.) are NOT filtered.
  // Useful for markets where prospects use personal email for business (SE Asia, India).
  allowPersonalDomains: boolean;
}

export function applyOutboundFilter(
  email: string,
  ctx: WorkspaceFilterContext,
): FilterResult {
  const domain = emailDomain(email);
  if (ctx.memberEmails.has(email)) return { pass: false, reason: 'teammate' };
  if (ctx.internalDomains.has(domain)) return { pass: false, reason: 'internal_domain' };
  if (ctx.dismissedEmails.has(email)) return { pass: false, reason: 'dismissed_email' };
  if (ctx.dismissedDomains.has(domain)) return { pass: false, reason: 'dismissed_domain' };
  if (!ctx.allowPersonalDomains && isPersonalDomain(domain)) return { pass: false, reason: 'personal_domain' };
  if (isRoleAddress(email)) return { pass: false, reason: 'role_address' };
  if (ctx.existingLeadEmails.has(email)) return { pass: false, reason: 'existing_lead' };
  return { pass: true, reason: 'pass' };
}

// Inbound signal detection — only surfaces emails with explicit DrivePilot mentions
// or verifiable referral language. Generic strangers are always filtered out.
const PRODUCT_SIGNALS = ['drivepilot', 'drive pilot', 'salesbrain', 'sales brain'];

const REFERRAL_PATTERNS = [
  /\b([\w][\w\s]{1,25}?) (?:told|said|recommended|suggested|mentioned|referred me|pointed me|sent me your way)\b/i,
  /\breferred(?: to you)? by\s+([\w][\w\s]{1,25})/i,
  /\bvia\s+[\w][\w\s]{0,25}?'?s?\s+(?:intro|introduction|referral)\b/i,
];

export interface InboundSignalResult {
  hasSignal: boolean;
  source: 'inbound_explicit' | 'inbound_referral' | null;
  referrerName: string | null;
}

export function detectInboundSignals(subject: string, bodyText: string): InboundSignalResult {
  const combined = `${subject} ${bodyText}`;
  const lower = combined.toLowerCase();

  if (PRODUCT_SIGNALS.some(s => lower.includes(s))) {
    return { hasSignal: true, source: 'inbound_explicit', referrerName: null };
  }

  for (const pattern of REFERRAL_PATTERNS) {
    const match = pattern.exec(combined);
    if (match) {
      const referrerName = (match[1] || match[2] || '').trim() || null;
      return { hasSignal: true, source: 'inbound_referral', referrerName };
    }
  }

  return { hasSignal: false, source: null, referrerName: null };
}

export function makeSnippet(text: string, maxLen = 300): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
