// ============================================================
// prospectProviders — Lead Scout's contact-data providers (Apollo + Lusha).
//
// Pure: fetch, apiKey and sleep are injected; no Deno.*, no env reads. Every
// call returns { data, credits, error } and NEVER throws — a provider hiccup
// must not abort a scout batch. 429 → wait `retry-after` once (if short) and
// retry; anything else fails closed (empty data + error string).
// Error strings never include the API key or the response body.
//
// Docs used (checked 2026-11-01):
//   Apollo People API Search  https://docs.apollo.io/reference/people-api-search
//     POST https://api.apollo.io/api/v1/mixed_people/api_search  (header x-api-key)
//     0 credits; returns NO email/phone, only first_name + last_name_obfuscated,
//     title, organization.name and has_* flags (no location / linkedin values).
//     (The old mixed_people/search endpoint is the credit-consuming legacy one.)
//   Apollo People Enrichment  https://docs.apollo.io/reference/people-enrichment
//     POST https://api.apollo.io/api/v1/people/match?id=...  (header x-api-key)
//     1 credit for email/demographics, +8 if a phone is revealed — we always
//     send reveal_phone_number=false and reveal_personal_emails=false.
//   Apollo rate limits        https://docs.apollo.io/reference/rate-limits
//     429 carries a `retry-after` header (seconds); platform-wide 429s carry
//     suggestions.retry_after_seconds in the body instead.
//   Lusha V3 Search & Enrich  https://docs.lusha.com/api-reference/search-and-enrich/search-and-enrich-contacts
//     POST https://api.lusha.com/v3/contacts/search-and-enrich  (header api_key)
//     body { contacts:[{linkedinUrl}|{firstName,lastName,companyDomain|companyName}],
//            reveal:["phones"] } → results[].phones[] { number, type, doNotCall },
//     billing.creditsCharged; per-contact failures in results[].error.
// Tested in prospectProviders.test.ts (fixture responses, fetch stubbed).
// ============================================================
import { normalizeProfileUrl } from "./linkedinLookup.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProviderDeps {
  fetch: FetchLike;
  apiKey: string;
  /** Injected so tests don't actually wait. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Longest 429 wait we honour before giving up. Default 10s (edge functions are short-lived). */
  maxRetryWaitMs?: number;
}

export interface ProviderResult<T> {
  data: T;
  credits: number;
  error: string | null;
}

export interface ProspectStub {
  provider: string;
  provider_person_id: string;
  first_name: string | null;
  /** Null when the provider only returns an obfuscated surname (Apollo search). */
  last_name: string | null;
  name: string | null;
  title: string | null;
  company_name: string | null;
  company_domain: string | null;
  company_size: string | null;
  location: string | null;
  linkedin_url: string | null;
}

export interface ApolloSearchFilters {
  titles?: string[];
  seniorities?: string[];
  locations?: string[];
  notLocations?: string[];
  /** Apollo format "min,max", e.g. "11,50". */
  employeeRanges?: string[];
  /** Apollo's own industry names (organization_industries[]). */
  industries?: string[];
  organizationDomains?: string[];
  keywords?: string;
  perPage?: number;
}

export interface EnrichedEmail {
  /** Only ever set when Apollo says email_status === "verified". */
  email: string | null;
  email_status: string | null;
  linkedin_url: string | null;
  first_name: string | null;
  last_name: string | null;
  location: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface PhoneResult {
  phone: string;
  phone_type: string;
}

// ponytail: one provider per job (Apollo = search + email, Lusha = phone).
// Ceiling: no fallback/waterfall — if Apollo is down or says no, Scout finds
// nobody that week. Upgrade path: implement ProspectProvider for PDL/Explorium
// and pick per workspace (or try in order) where the caller builds the provider.
export interface ProspectProvider {
  name: string;
  search(filters: ApolloSearchFilters, page: number): Promise<ProviderResult<ProspectStub[]>>;
  enrich(stub: ProspectStub): Promise<ProviderResult<EnrichedEmail | null>>;
}

const APOLLO_BASE = "https://api.apollo.io/api/v1";
const LUSHA_URL = "https://api.lusha.com/v3/contacts/search-and-enrich";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** "https://www.Acme.com/about" → "acme.com". */
export function normalizeDomain(input: string | null | undefined): string | null {
  const s = (input || "").trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0];
  return s || null;
}

function retryAfterMs(res: Response, body: unknown): number | null {
  const h = res.headers.get("retry-after");
  if (h && /^\d+(\.\d+)?$/.test(h.trim())) return Number(h) * 1000;
  // deno-lint-ignore no-explicit-any
  const s = (body as any)?.suggestions?.retry_after_seconds ?? (body as any)?.retry_after_seconds;
  return typeof s === "number" ? s * 1000 : null;
}

/** JSON request with one 429 retry; returns { json } or { error }, never throws. */
async function requestJson(
  deps: ProviderDeps,
  label: string,
  url: string,
  init: RequestInit,
): Promise<{ json: unknown; error: string | null }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = deps.maxRetryWaitMs ?? 10_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(url, init);
    } catch (e) {
      return { json: null, error: `${label}: network error (${e instanceof Error ? e.name : "unknown"})` };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok) {
      return body === null ? { json: null, error: `${label}: invalid JSON` } : { json: body, error: null };
    }
    if (res.status === 429 && attempt === 0) {
      const wait = retryAfterMs(res, body);
      if (wait !== null && wait <= maxWait) {
        await sleep(wait);
        continue;
      }
      return { json: null, error: `${label}: rate limited (retry-after ${wait === null ? "missing" : `${wait / 1000}s`})` };
    }
    return { json: null, error: `${label}: HTTP ${res.status}` };
  }
  return { json: null, error: `${label}: rate limited after retry` };
}

function apolloHeaders(apiKey: string): HeadersInit {
  return { "x-api-key": apiKey, "Content-Type": "application/json", "Cache-Control": "no-cache", accept: "application/json" };
}

function joinLocation(...parts: unknown[]): string | null {
  const s = parts.map(str).filter(Boolean).join(", ");
  return s || null;
}

// deno-lint-ignore no-explicit-any
function apolloStub(p: any): ProspectStub | null {
  const id = str(p?.id);
  if (!id) return null;
  const first = str(p.first_name);
  const last = str(p.last_name); // search returns last_name_obfuscated only → null
  const org = p.organization ?? {};
  const size = typeof org.estimated_num_employees === "number" ? String(org.estimated_num_employees) : null;
  return {
    provider: "apollo",
    provider_person_id: id,
    first_name: first,
    last_name: last,
    name: str(p.name) ?? (first && last ? `${first} ${last}` : null),
    title: str(p.title),
    company_name: str(org.name),
    company_domain: normalizeDomain(str(org.primary_domain) ?? str(org.website_url)),
    company_size: size,
    location: joinLocation(p.city, p.state, p.country),
    linkedin_url: str(p.linkedin_url) ? normalizeProfileUrl(p.linkedin_url) : null,
  };
}

/** Apollo People API Search — free (0 credits), no contact data. */
export async function apolloSearchPeople(
  deps: ProviderDeps,
  filters: ApolloSearchFilters,
  page = 1,
): Promise<ProviderResult<ProspectStub[]>> {
  const q = new URLSearchParams();
  const many = (key: string, vals?: string[]) => (vals ?? []).forEach((v) => v && q.append(`${key}[]`, v));
  many("person_titles", filters.titles);
  many("person_seniorities", filters.seniorities);
  many("person_locations", filters.locations);
  many("person_not_locations", filters.notLocations);
  many("organization_num_employees_ranges", filters.employeeRanges);
  many("organization_industries", filters.industries);
  many("q_organization_domains_list", filters.organizationDomains);
  if (filters.keywords) q.set("q_keywords", filters.keywords);
  q.set("page", String(Math.max(1, Math.floor(page))));
  q.set("per_page", String(Math.min(100, Math.max(1, filters.perPage ?? 25))));

  const { json, error } = await requestJson(deps, "apollo search", `${APOLLO_BASE}/mixed_people/api_search?${q}`, {
    method: "POST",
    headers: apolloHeaders(deps.apiKey),
  });
  if (error) return { data: [], credits: 0, error };
  // deno-lint-ignore no-explicit-any
  const people = (json as any)?.people;
  if (!Array.isArray(people)) return { data: [], credits: 0, error: "apollo search: no people array" };
  return { data: people.map(apolloStub).filter((s): s is ProspectStub => s !== null), credits: 0, error: null };
}

/** Apollo People Enrichment by person id. Email kept only when verified; phone never requested. */
export async function apolloEnrichPerson(
  deps: ProviderDeps,
  stub: Pick<ProspectStub, "provider_person_id">,
): Promise<ProviderResult<EnrichedEmail | null>> {
  const q = new URLSearchParams({
    id: stub.provider_person_id,
    reveal_personal_emails: "false",
    reveal_phone_number: "false",
  });
  const { json, error } = await requestJson(deps, "apollo enrich", `${APOLLO_BASE}/people/match?${q}`, {
    method: "POST",
    headers: apolloHeaders(deps.apiKey),
  });
  if (error) return { data: null, credits: 0, error };
  // deno-lint-ignore no-explicit-any
  const p = (json as any)?.person;
  if (!p) return { data: null, credits: 0, error: null };
  const status = str(p.email_status);
  const email = status === "verified" ? str(p.email)?.toLowerCase() ?? null : null;
  // ponytail: Apollo doesn't echo credits charged; 1 per returned person is the
  // documented upper bound without a phone reveal (0 when match_confidence is none).
  const credits = p.match_confidence === "none" ? 0 : 1;
  return {
    data: {
      email,
      email_status: status,
      linkedin_url: str(p.linkedin_url) ? normalizeProfileUrl(p.linkedin_url) : null,
      first_name: str(p.first_name),
      last_name: str(p.last_name),
      location: joinLocation(p.city, p.state, p.country),
      city: str(p.city),
      state: str(p.state),
      country: str(p.country),
    },
    credits,
    error: null,
  };
}

const PHONE_PREFERENCE = ["mobile", "direct", "work", "unknown"];

/** Lusha V3 phone lookup. Needs a LinkedIn URL, or first+last name plus company domain/name. */
export async function lushaPhone(
  deps: ProviderDeps,
  stub: Pick<ProspectStub, "provider_person_id" | "linkedin_url" | "first_name" | "last_name" | "company_domain" | "company_name">,
): Promise<ProviderResult<PhoneResult | null>> {
  let contact: Record<string, string>;
  if (stub.linkedin_url) {
    contact = { linkedinUrl: stub.linkedin_url };
  } else if (stub.first_name && stub.last_name && (stub.company_domain || stub.company_name)) {
    contact = {
      firstName: stub.first_name,
      lastName: stub.last_name,
      ...(stub.company_domain ? { companyDomain: stub.company_domain } : { companyName: stub.company_name! }),
    };
  } else {
    return { data: null, credits: 0, error: "lusha: not enough identifiers" };
  }
  const { json, error } = await requestJson(deps, "lusha", LUSHA_URL, {
    method: "POST",
    headers: { api_key: deps.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contacts: [{ ...contact, clientReferenceId: stub.provider_person_id }],
      reveal: ["phones"],
    }),
  });
  if (error) return { data: null, credits: 0, error };
  // deno-lint-ignore no-explicit-any
  const body = json as any;
  const credits = typeof body?.billing?.creditsCharged === "number" ? body.billing.creditsCharged : 0;
  const r = Array.isArray(body?.results) ? body.results[0] : null;
  if (!r) return { data: null, credits, error: null };
  if (r.error) return { data: null, credits, error: `lusha: ${str(r.error.code) ?? "error"}` };
  // deno-lint-ignore no-explicit-any
  const phones = (Array.isArray(r.phones) ? r.phones : []).filter((ph: any) => str(ph?.number) && ph.doNotCall !== true);
  const rank = (t: unknown) => {
    const i = PHONE_PREFERENCE.indexOf(String(t));
    return i < 0 ? PHONE_PREFERENCE.length : i;
  };
  // deno-lint-ignore no-explicit-any
  phones.sort((a: any, b: any) => rank(a.type) - rank(b.type));
  const best = phones[0];
  return { data: best ? { phone: best.number.trim(), phone_type: str(best.type) ?? "unknown" } : null, credits, error: null };
}

/** Apollo as a ProspectProvider (search + verified email). */
export function apolloProvider(deps: ProviderDeps): ProspectProvider {
  return {
    name: "apollo",
    search: (filters, page) => apolloSearchPeople(deps, filters, page),
    enrich: (stub) => apolloEnrichPerson(deps, stub),
  };
}
