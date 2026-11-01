// ============================================================
// scoutFilters — drop Lead Scout prospects the workspace must never see.
//
// Pure: the caller loads every list (leads, suppression, dismiss lists,
// existing scout candidates) and passes plain arrays; no DB access here.
// Rules, in order (first match wins, reported as the drop reason):
//   duplicate_in_batch   same provider person twice in one batch
//   existing_candidate   a scout row already exists for this provider person
//                        (pending, approved or dismissed — never re-suggest)
//   unsubscribed         email belongs to a lead who unsubscribed
//   suppressed_email / suppressed_domain   campaign_suppression_list
//   dismissed_email / dismissed_domain     workspace_dismissed_* ("competitor"
//                                          = a dismissed/suppressed domain)
//   internal_domain      workspace_internal_domains (a teammate)
//   existing_lead        matches a lead by email, LinkedIn URL, or
//                        name + company domain
//   eu_location          EU/UK/EEA location while allowEu is false
// Domain rules also match subdomains (blocking acme.com blocks eu.acme.com).
//
// Unknown location is KEPT: Apollo search returns no location values, so the
// caller must (a) pass EU_UK_EEA_COUNTRIES as person_not_locations to Apollo
// and (b) re-run this filter after enrichment, when the country is known.
// Same for name+domain: search gives an obfuscated surname, so that rule only
// bites after enrichment.
// Tested in scoutFilters.test.ts.
// ============================================================
import { normalizeEmail } from "./leadCandidateDetection.ts";
import { normalizeProfileUrl } from "./linkedinLookup.ts";
import { normalizeDomain } from "./prospectProviders.ts";

export interface ScoutFilterStub {
  provider: string;
  provider_person_id: string;
  name?: string | null;
  email?: string | null;
  linkedin_url?: string | null;
  company_domain?: string | null;
  location?: string | null;
}

export interface ScoutFilterContext {
  leads: Array<{ email?: string | null; linkedin_url?: string | null; name?: string | null }>;
  unsubscribedEmails: string[];
  suppressedEmails: string[];
  suppressedDomains: string[];
  dismissedEmails: string[];
  dismissedDomains: string[];
  internalDomains: string[];
  /** Existing lead_candidates rows with source='ai_scout' (any status). */
  existingScoutCandidates: Array<{ provider: string | null; provider_person_id: string | null }>;
  allowEu: boolean;
}

export type ScoutDropReason =
  | "duplicate_in_batch"
  | "existing_candidate"
  | "unsubscribed"
  | "suppressed_email"
  | "suppressed_domain"
  | "dismissed_email"
  | "dismissed_domain"
  | "internal_domain"
  | "existing_lead"
  | "eu_location";

/** EU-27 + EEA (Iceland, Liechtenstein, Norway) + UK, as names Apollo/Lusha use. */
export const EU_UK_EEA_COUNTRIES = [
  "Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Czech Republic",
  "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland",
  "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland",
  "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden",
  "Iceland", "Liechtenstein", "Norway",
  "United Kingdom",
];
// Extra spellings seen in location strings; matched but not sent to Apollo.
const EU_ALIASES = [
  "the netherlands", "holland", "uk", "u.k.", "great britain", "england", "scotland",
  "wales", "northern ireland", "republic of ireland", "deutschland", "españa", "italia",
];
const EU_SET = new Set([...EU_UK_EEA_COUNTRIES.map((c) => c.toLowerCase()), ...EU_ALIASES]);

/** True when any comma-separated part of the location is an EU/UK/EEA country. */
export function isEuLocation(location: string | null | undefined): boolean {
  if (!location) return false;
  return location.split(",").some((part) => EU_SET.has(part.trim().toLowerCase()));
}

const normEmail = (e: string | null | undefined) => (e && e.includes("@") ? normalizeEmail(e) : null);

/** "José  Cohen" → "jose cohen". */
export function normalizeName(name: string | null | undefined): string {
  return (name || "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function domainSet(list: string[]): Set<string> {
  return new Set(list.map(normalizeDomain).filter((d): d is string => !!d));
}

/** Domain or any parent domain is in the set. */
function domainHit(domain: string | null, set: Set<string>): boolean {
  if (!domain) return false;
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (set.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

export function filterScoutCandidates<T extends ScoutFilterStub>(
  stubs: T[],
  ctx: ScoutFilterContext,
): { kept: T[]; dropped: Array<{ stub: T; reason: ScoutDropReason }> } {
  const emails = (list: string[]) => new Set(list.map(normEmail).filter((e): e is string => !!e));
  const unsub = emails(ctx.unsubscribedEmails);
  const supEmails = emails(ctx.suppressedEmails);
  const disEmails = emails(ctx.dismissedEmails);
  const supDomains = domainSet(ctx.suppressedDomains);
  const disDomains = domainSet(ctx.dismissedDomains);
  const internal = domainSet(ctx.internalDomains);

  const leadEmails = new Set<string>();
  const leadLinkedin = new Set<string>();
  const leadNameDomain = new Set<string>();
  for (const l of ctx.leads) {
    const e = normEmail(l.email);
    if (e) leadEmails.add(e);
    const li = l.linkedin_url ? normalizeProfileUrl(l.linkedin_url) : null;
    if (li) leadLinkedin.add(li);
    const n = normalizeName(l.name);
    if (e && n) leadNameDomain.add(`${n}|${e.split("@")[1]}`);
  }

  const key = (provider: string | null, id: string | null) => `${provider ?? ""}:${id ?? ""}`;
  const existing = new Set(ctx.existingScoutCandidates.map((c) => key(c.provider, c.provider_person_id)));
  const seen = new Set<string>();

  const kept: T[] = [];
  const dropped: Array<{ stub: T; reason: ScoutDropReason }> = [];

  for (const s of stubs) {
    const k = key(s.provider, s.provider_person_id);
    const email = normEmail(s.email);
    const domain = normalizeDomain(s.company_domain);
    const emailDomain = email ? email.split("@")[1] : null;
    const li = s.linkedin_url ? normalizeProfileUrl(s.linkedin_url) : null;
    const name = normalizeName(s.name);
    const domainsHit = (set: Set<string>) => domainHit(domain, set) || domainHit(emailDomain, set);

    let reason: ScoutDropReason | null = null;
    if (seen.has(k)) reason = "duplicate_in_batch";
    else if (existing.has(k)) reason = "existing_candidate";
    else if (email && unsub.has(email)) reason = "unsubscribed";
    else if (email && supEmails.has(email)) reason = "suppressed_email";
    else if (domainsHit(supDomains)) reason = "suppressed_domain";
    else if (email && disEmails.has(email)) reason = "dismissed_email";
    else if (domainsHit(disDomains)) reason = "dismissed_domain";
    else if (domainsHit(internal)) reason = "internal_domain";
    else if (
      (email && leadEmails.has(email)) ||
      (li && leadLinkedin.has(li)) ||
      (name && [domain, emailDomain].some((d) => d && leadNameDomain.has(`${name}|${d}`)))
    ) reason = "existing_lead";
    else if (!ctx.allowEu && isEuLocation(s.location)) reason = "eu_location";

    seen.add(k);
    if (reason) dropped.push({ stub: s, reason });
    else kept.push(s);
  }
  return { kept, dropped };
}
