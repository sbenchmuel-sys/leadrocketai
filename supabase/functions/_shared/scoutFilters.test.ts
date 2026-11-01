// Run: deno test supabase/functions/_shared/scoutFilters.test.ts
//
// Pins every Lead Scout drop rule: a prospect the workspace already knows,
// opted out, dismissed or suppressed must never be re-suggested, and EU/UK/EEA
// people are dropped unless the workspace allows them.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  filterScoutCandidates,
  isEuLocation,
  normalizeName,
  type ScoutFilterContext,
  type ScoutFilterStub,
} from "./scoutFilters.ts";

const empty: ScoutFilterContext = {
  leads: [],
  unsubscribedEmails: [],
  suppressedEmails: [],
  suppressedDomains: [],
  dismissedEmails: [],
  dismissedDomains: [],
  internalDomains: [],
  existingScoutCandidates: [],
  allowEu: false,
};

let n = 0;
const stub = (over: Partial<ScoutFilterStub> = {}): ScoutFilterStub => ({
  provider: "apollo",
  provider_person_id: `p${++n}`,
  name: "Dana Cohen",
  email: null,
  linkedin_url: null,
  company_domain: "acme.com",
  location: "Austin, Texas, United States",
  ...over,
});

function reasonFor(s: ScoutFilterStub, ctx: Partial<ScoutFilterContext>) {
  const r = filterScoutCandidates([s], { ...empty, ...ctx });
  return r.dropped[0]?.reason ?? "kept";
}

Deno.test("clean prospect is kept", () => {
  assertEquals(reasonFor(stub(), {}), "kept");
});

Deno.test("normalizeName folds case, accents and punctuation", () => {
  assertEquals(normalizeName("  José  O'Brien "), "jose o brien");
});

Deno.test("duplicate provider person inside one batch is dropped", () => {
  const a = stub();
  const r = filterScoutCandidates([a, { ...a }], empty);
  assertEquals(r.kept.length, 1);
  assertEquals(r.dropped[0].reason, "duplicate_in_batch");
});

Deno.test("existing scout candidate (pending or dismissed) is never re-suggested", () => {
  const s = stub();
  assertEquals(reasonFor(s, { existingScoutCandidates: [{ provider: "apollo", provider_person_id: s.provider_person_id }] }), "existing_candidate");
  // same id from a different provider is a different person
  assertEquals(reasonFor(s, { existingScoutCandidates: [{ provider: "pdl", provider_person_id: s.provider_person_id }] }), "kept");
});

Deno.test("unsubscribed lead email (case / plus-alias insensitive)", () => {
  assertEquals(reasonFor(stub({ email: "Dana+x@Acme.com" }), { unsubscribedEmails: ["dana@acme.com"] }), "unsubscribed");
});

Deno.test("campaign_suppression_list email and domain (incl. subdomains)", () => {
  assertEquals(reasonFor(stub({ email: "dana@acme.com" }), { suppressedEmails: ["DANA@acme.com"] }), "suppressed_email");
  assertEquals(reasonFor(stub({ company_domain: "eu.acme.com" }), { suppressedDomains: ["www.acme.com"] }), "suppressed_domain");
  assertEquals(reasonFor(stub({ company_domain: null, email: "d@acme.com" }), { suppressedDomains: ["acme.com"] }), "suppressed_domain");
  assertEquals(reasonFor(stub({ company_domain: "notacme.com" }), { suppressedDomains: ["acme.com"] }), "kept");
});

Deno.test("workspace dismissed email / domain and internal domain", () => {
  assertEquals(reasonFor(stub({ email: "dana@acme.com" }), { dismissedEmails: ["dana@acme.com"] }), "dismissed_email");
  assertEquals(reasonFor(stub(), { dismissedDomains: ["acme.com"] }), "dismissed_domain");
  assertEquals(reasonFor(stub(), { internalDomains: ["ACME.com"] }), "internal_domain");
});

Deno.test("existing lead by email", () => {
  assertEquals(reasonFor(stub({ email: "dana@acme.com" }), { leads: [{ email: "Dana@Acme.com" }] }), "existing_lead");
});

Deno.test("existing lead by LinkedIn URL (normalized)", () => {
  assertEquals(
    reasonFor(stub({ linkedin_url: "https://uk.linkedin.com/in/Dana-Cohen?trk=x" }), {
      leads: [{ email: "other@else.com", linkedin_url: "http://www.linkedin.com/in/dana-cohen/" }],
    }),
    "existing_lead",
  );
});

Deno.test("existing lead by name + company domain", () => {
  const leads = [{ email: "dcohen@acme.com", name: "Dána Cohen" }];
  assertEquals(reasonFor(stub({ name: "dana cohen", company_domain: "www.acme.com" }), { leads }), "existing_lead");
  assertEquals(reasonFor(stub({ name: "Dana Cohen", company_domain: "other.com" }), { leads }), "kept");
  assertEquals(reasonFor(stub({ name: null }), { leads }), "kept");
});

Deno.test("EU/UK/EEA gate", () => {
  assertEquals(isEuLocation("Berlin, Germany"), true);
  assertEquals(isEuLocation("London, England, United Kingdom"), true);
  assertEquals(isEuLocation("Oslo, Norway"), true);
  assertEquals(isEuLocation("Boston, New England, United States"), false);
  assertEquals(isEuLocation("Tel Aviv, Israel"), false);
  assertEquals(isEuLocation(null), false);
  assertEquals(reasonFor(stub({ location: "Dublin, Ireland" }), {}), "eu_location");
  assertEquals(reasonFor(stub({ location: "Dublin, Ireland" }), { allowEu: true }), "kept");
  assertEquals(reasonFor(stub({ location: null }), {}), "kept"); // unknown until enrichment
});
