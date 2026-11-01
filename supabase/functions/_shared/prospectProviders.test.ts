// Run: deno test supabase/functions/_shared/prospectProviders.test.ts
//
// Pins the Lead Scout provider layer against fixture responses shaped like the
// Apollo / Lusha docs (see prospectProviders.ts header). fetch is stubbed —
// nothing here calls a real provider. Covers: normalization, verified-only
// email, never asking Apollo for a phone, one 429 retry, fail-closed.
import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  apolloEnrichPerson,
  apolloSearchPeople,
  lushaPhone,
  normalizeDomain,
  type ProviderDeps,
} from "./prospectProviders.ts";

type Call = { url: string; init?: RequestInit };

function stubFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("unexpected extra fetch");
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function deps(responses: Array<Response | Error>, extra: Partial<ProviderDeps> = {}) {
  const f = stubFetch(responses);
  const slept: number[] = [];
  const d: ProviderDeps = {
    fetch: f.fetch,
    apiKey: "test-key",
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    ...extra,
  };
  return { d, calls: f.calls, slept };
}

// Shape from docs.apollo.io/reference/people-api-search
const APOLLO_SEARCH_FIXTURE = {
  total_entries: 2,
  people: [
    {
      id: "p1",
      first_name: "Dana",
      last_name_obfuscated: "Co***n",
      title: "Head of Sales",
      has_email: true,
      organization: { name: "Acme Payments", has_employee_count: true },
    },
    { first_name: "NoId" },
  ],
};

// Shape from docs.apollo.io/reference/people-enrichment
const apolloMatch = (email_status: string) => ({
  person: {
    id: "p1",
    first_name: "Dana",
    last_name: "Cohen",
    name: "Dana Cohen",
    email: "Dana.Cohen@Acme.com",
    email_status,
    linkedin_url: "http://www.linkedin.com/in/Dana-Cohen/",
    city: "Austin",
    state: "Texas",
    country: "United States",
    match_confidence: "high",
    organization: { name: "Acme Payments", primary_domain: "acme.com", estimated_num_employees: 120 },
  },
});

// Shape from docs.lusha.com .../search-and-enrich-contacts
const LUSHA_FIXTURE = {
  requestId: "r1",
  results: [{
    clientReferenceId: "p1",
    phones: [
      { number: "+14155550000", type: "work", doNotCall: false },
      { number: "+14155551111", type: "mobile", doNotCall: true },
      { number: "+14155552222", type: "direct", doNotCall: false },
    ],
  }],
  billing: { creditsCharged: 2, resultsReturned: 1 },
};

Deno.test("normalizeDomain strips scheme, www and path", () => {
  assertEquals(normalizeDomain("https://www.Acme.com/about?x=1"), "acme.com");
  assertEquals(normalizeDomain("  "), null);
});

Deno.test("apolloSearchPeople hits api_search with x-api-key and normalizes stubs, 0 credits", async () => {
  const { d, calls } = deps([json(APOLLO_SEARCH_FIXTURE)]);
  const r = await apolloSearchPeople(d, { titles: ["Head of Sales"], notLocations: ["Germany"], industries: ["financial services"], perPage: 500 }, 2);
  assertEquals(r.error, null);
  assertEquals(r.credits, 0);
  assertEquals(r.data.length, 1, "row without id is dropped");
  assertEquals(r.data[0], {
    provider: "apollo",
    provider_person_id: "p1",
    first_name: "Dana",
    last_name: null, // obfuscated surname is never used as a real one
    name: null,
    title: "Head of Sales",
    company_name: "Acme Payments",
    company_domain: null,
    company_size: null,
    location: null,
    linkedin_url: null,
  });
  const url = new URL(calls[0].url);
  assertEquals(url.origin + url.pathname, "https://api.apollo.io/api/v1/mixed_people/api_search");
  assertEquals(url.searchParams.getAll("person_titles[]"), ["Head of Sales"]);
  assertEquals(url.searchParams.getAll("person_not_locations[]"), ["Germany"]);
  assertEquals(url.searchParams.getAll("organization_industries[]"), ["financial services"]);
  assertEquals(url.searchParams.get("page"), "2");
  assertEquals(url.searchParams.get("per_page"), "100", "clamped to Apollo max");
  assertEquals((calls[0].init?.headers as Record<string, string>)["x-api-key"], "test-key");
});

Deno.test("apolloEnrichPerson keeps a verified email, never asks for phone", async () => {
  const { d, calls } = deps([json(apolloMatch("verified"))]);
  const r = await apolloEnrichPerson(d, { provider_person_id: "p1" });
  assertEquals(r.error, null);
  assertEquals(r.credits, 1);
  assertEquals(r.data?.email, "dana.cohen@acme.com");
  assertEquals(r.data?.linkedin_url, "https://www.linkedin.com/in/dana-cohen");
  assertEquals(r.data?.location, "Austin, Texas, United States");
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/api/v1/people/match");
  assertEquals(url.searchParams.get("id"), "p1");
  assertEquals(url.searchParams.get("reveal_phone_number"), "false");
  assertEquals(url.searchParams.get("reveal_personal_emails"), "false");
});

Deno.test("apolloEnrichPerson drops any non-verified email", async () => {
  for (const status of ["unverified", "extrapolated", "likely to engage", "unavailable"]) {
    const { d } = deps([json(apolloMatch(status))]);
    const r = await apolloEnrichPerson(d, { provider_person_id: "p1" });
    assertEquals(r.data?.email, null, status);
    assertEquals(r.data?.email_status, status);
  }
});

Deno.test("429 with short retry-after waits once and retries", async () => {
  const { d, calls, slept } = deps([json({}, 429, { "retry-after": "2" }), json(apolloMatch("verified"))]);
  const r = await apolloEnrichPerson(d, { provider_person_id: "p1" });
  assertEquals(r.error, null);
  assertEquals(r.data?.email, "dana.cohen@acme.com");
  assertEquals(slept, [2000]);
  assertEquals(calls.length, 2);
});

Deno.test("429 body suggestion (platform limit) is honoured too", async () => {
  const { d, slept } = deps([json({ suggestions: { retry_after_seconds: 1 } }, 429), json(APOLLO_SEARCH_FIXTURE)], {});
  const r = await apolloSearchPeople(d, {});
  assertEquals(r.error, null);
  assertEquals(slept, [1000]);
});

Deno.test("429 twice, or a retry-after too long to wait, fails closed", async () => {
  const twice = deps([json({}, 429, { "retry-after": "1" }), json({}, 429, { "retry-after": "1" })]);
  const r1 = await apolloSearchPeople(twice.d, {});
  assertEquals(r1.data, []);
  assert(r1.error?.includes("429"), r1.error ?? "");
  assertEquals(twice.calls.length, 2, "only one retry");

  const long = deps([json({}, 429, { "retry-after": "3600" })]);
  const r2 = await apolloEnrichPerson(long.d, { provider_person_id: "p1" });
  assertEquals(r2.data, null);
  assert(r2.error?.includes("rate limited"));
  assertEquals(long.slept, [], "never sleeps an hour inside an edge function");
});

Deno.test("fail closed: HTTP errors, network errors and bad JSON never throw", async () => {
  const cases: Array<Response | Error> = [
    json({ message: "nope" }, 401),
    json({}, 500),
    new TypeError("connection reset"),
    new Response("<html>", { status: 200 }),
  ];
  for (const c of cases) {
    const { d } = deps([c]);
    const s = await apolloSearchPeople(d, {});
    assertEquals(s.data, []);
    assertEquals(s.credits, 0);
    assert(s.error && !s.error.includes("test-key"), s.error ?? "");
  }
  const { d } = deps([json({ statusCode: 402, message: "Insufficient credits" }, 402)]);
  const l = await lushaPhone(d, { provider_person_id: "p1", linkedin_url: "https://www.linkedin.com/in/dana", first_name: null, last_name: null, company_domain: null, company_name: null });
  assertEquals(l.data, null);
  assertEquals(l.error, "lusha: HTTP 402");
});

Deno.test("lushaPhone prefers mobile > direct > work, skips doNotCall, reports credits", async () => {
  const { d, calls } = deps([json(LUSHA_FIXTURE)]);
  const r = await lushaPhone(d, {
    provider_person_id: "p1",
    linkedin_url: null,
    first_name: "Dana",
    last_name: "Cohen",
    company_domain: "acme.com",
    company_name: "Acme",
  });
  assertEquals(r, { data: { phone: "+14155552222", phone_type: "direct" }, credits: 2, error: null });
  assertEquals(calls[0].url, "https://api.lusha.com/v3/contacts/search-and-enrich");
  assertEquals((calls[0].init?.headers as Record<string, string>).api_key, "test-key");
  assertEquals(JSON.parse(String(calls[0].init?.body)), {
    contacts: [{ firstName: "Dana", lastName: "Cohen", companyDomain: "acme.com", clientReferenceId: "p1" }],
    reveal: ["phones"],
  });
});

Deno.test("lushaPhone: per-contact error and missing identifiers fail closed", async () => {
  const { d } = deps([json({ results: [{ error: { code: "NOT_FOUND", message: "x" } }], billing: { creditsCharged: 1 } })]);
  const r = await lushaPhone(d, { provider_person_id: "p1", linkedin_url: "https://www.linkedin.com/in/dana", first_name: null, last_name: null, company_domain: null, company_name: null });
  assertEquals(r, { data: null, credits: 1, error: "lusha: NOT_FOUND" });

  const none = deps([]);
  const r2 = await lushaPhone(none.d, { provider_person_id: "p1", linkedin_url: null, first_name: "Dana", last_name: null, company_domain: "acme.com", company_name: null });
  assertEquals(r2, { data: null, credits: 0, error: "lusha: not enough identifiers" });
  assertEquals(none.calls.length, 0, "no paid call without identifiers");
});
