// Run: deno test supabase/functions/_shared/scoutProfile.test.ts
//
// Pins the Lead Scout edge-function decisions: AI output is clamped to the
// profile_json schema, anchors can't be invented, the needs_input and
// sample rate-limit decisions, and sample-pick parsing.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  clampProfile,
  clampVotes,
  needsInput,
  normalizeEmployeeRange,
  parseSamplePicks,
  profileSentence,
  sampleRateLimit,
  toApolloFilters,
} from "./scoutProfile.ts";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const INVENTED = "99999999-9999-4999-8999-999999999999";

// Fixture: what a model might plausibly return — extra keys, wrong types,
// dupes, junk seniorities, free-text ranges, an invented anchor id.
const AI_FIXTURE = {
  titles: ["VP Sales", "  vp   sales ", "Head of Revenue", 42, null, "x".repeat(200)],
  seniorities: ["VP", "C-Suite", "director", "wizard"],
  industries: "financial services",
  employee_ranges: ["50-500", "10,001+", "500-50", "lots", "11,50"],
  locations: ["United States", "Canada"],
  keywords: [],
  exclusions: ["banks"],
  anchor_lead_ids: [A1, INVENTED, "not-a-uuid", A2],
  profile_sentence: "ignored",
  sql: "drop table leads",
};

Deno.test("clampProfile: only schema keys, cleaned, deduped, capped", () => {
  const p = clampProfile(AI_FIXTURE, [A1, A2]);
  assertEquals(Object.keys(p).sort(), [
    "anchor_lead_ids", "employee_ranges", "exclusions", "industries", "keywords", "locations", "seniorities", "titles",
  ]);
  assertEquals(p.titles, ["VP Sales", "Head of Revenue", "42", "x".repeat(60)]);
  assertEquals(p.seniorities, ["vp", "c_suite", "director"]);
  assertEquals(p.industries, ["financial services"]);
  assertEquals(p.employee_ranges, ["50,500", "10001,", "11,50"]);
  assertEquals(p.anchor_lead_ids, [A1, A2]);
});

Deno.test("clampProfile: anchors not offered by the server are dropped", () => {
  assertEquals(clampProfile({ anchor_lead_ids: [A1, A2] }, [A2]).anchor_lead_ids, [A2]);
  assertEquals(clampProfile({ anchor_lead_ids: [A1] }).anchor_lead_ids, []);
});

Deno.test("clampProfile: garbage in → empty profile", () => {
  for (const junk of [null, undefined, "text", 5, [1, 2]]) {
    const p = clampProfile(junk);
    assertEquals(Object.values(p).every((l) => l.length === 0), true);
  }
});

Deno.test("clampProfile: list caps", () => {
  const p = clampProfile({ titles: Array.from({ length: 30 }, (_, i) => `T${i}`), anchor_lead_ids: [A1, A2] }, [A1, A2]);
  assertEquals(p.titles.length, 10);
});

Deno.test("normalizeEmployeeRange", () => {
  assertEquals(normalizeEmployeeRange("51–200"), "51,200");
  assertEquals(normalizeEmployeeRange("51 to 200"), "51,200");
  assertEquals(normalizeEmployeeRange("10001,"), "10001,");
  assertEquals(normalizeEmployeeRange("0-10"), null);
  assertEquals(normalizeEmployeeRange("200-51"), null);
});

Deno.test("needsInput: <5 good leads asks, unless the rep already answered", () => {
  assertEquals(needsInput(0, false), true);
  assertEquals(needsInput(4, false), true);
  assertEquals(needsInput(4, true), false);
  assertEquals(needsInput(5, false), false);
});

Deno.test("sampleRateLimit: 10 per hour", () => {
  assertEquals(sampleRateLimit(0), { allowed: true, remaining: 10 });
  assertEquals(sampleRateLimit(9), { allowed: true, remaining: 1 });
  assertEquals(sampleRateLimit(10), { allowed: false, remaining: 0 });
  assertEquals(sampleRateLimit(25), { allowed: false, remaining: 0 });
});

const STUBS = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ provider_person_id: id }));

Deno.test("parseSamplePicks: keeps only real ids, dedupes, max 5, trims reasons", () => {
  const picks = parseSamplePicks({
    picks: [
      { id: "b", reason: "  Runs sales at a\n fintech  " },
      { id: "zzz", reason: "invented" },
      { id: "b", reason: "dupe" },
      { id: "c" },
      { id: "d", reason: "x" }, { id: "e", reason: "x" }, { id: "f", reason: "x" }, { id: "g", reason: "x" },
    ],
  }, STUBS);
  assertEquals(picks.map((p) => p.stub.provider_person_id), ["b", "c", "d", "e", "f"]);
  assertEquals(picks[0].reason, "Runs sales at a fintech");
  assertEquals(picks[1].reason.length > 0, true);
});

Deno.test("parseSamplePicks: unusable AI output falls back to the first 5", () => {
  assertEquals(parseSamplePicks(null, STUBS).map((p) => p.stub.provider_person_id), ["a", "b", "c", "d", "e"]);
  assertEquals(parseSamplePicks({}, []), []);
});

Deno.test("clampVotes: unknown votes/reasons dropped; reasons only on 👎", () => {
  const v = clampVotes([
    { vote: "down", reason: "Too Small", title: "CEO" },
    { vote: "up", reason: "too small" },
    { vote: "down", reason: "hacker" },
    { vote: "maybe" },
    "junk",
  ]);
  assertEquals(v.map((x) => [x.vote, x.reason]), [["down", "too small"], ["up", null], ["down", null]]);
  assertEquals(v[0].title, "CEO");
});

Deno.test("toApolloFilters passes the EU exclusion through", () => {
  const p = clampProfile({ titles: ["VP Sales"], employee_ranges: ["51,200"], locations: ["United States"] });
  const f = toApolloFilters(p, ["Germany"]);
  assertEquals(f.notLocations, ["Germany"]);
  assertEquals(f.employeeRanges, ["51,200"]);
  assertEquals(f.titles, ["VP Sales"]);
});

Deno.test("profileSentence reads naturally", () => {
  const p = clampProfile({
    titles: ["VP Sales"], seniorities: ["director"], industries: ["fintech"], employee_ranges: ["51,200"],
    locations: ["United States"], anchor_lead_ids: [A1], exclusions: ["banks"],
  }, [A1]);
  assertEquals(
    profileSentence(p, { [A1]: "Acme Pay" }),
    "I'll look for VP Sales or directors at fintech companies, 51–200 employees, in United States, similar to Acme Pay. Skipping banks.",
  );
});

Deno.test("parseSamplePicks: a valid empty or all-unknown picks list stays empty (exclusions hold)", () => {
  assertEquals(parseSamplePicks({ picks: [] }, STUBS), []);
  assertEquals(parseSamplePicks({ picks: [{ id: "nope" }] }, STUBS.slice(0, 2)), []);
});
