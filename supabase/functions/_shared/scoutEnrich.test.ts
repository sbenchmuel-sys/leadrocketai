// Run: deno test supabase/functions/_shared/scoutEnrich.test.ts
// Enrichment order + credit rules (fixtures; no real Apollo/Lusha):
//   no verified email → dismissed, Lusha never called
//   blocked after enrichment → dismissed with the filter reason, no Lusha
//   happy path → lead payload incl. raw_import_json.scout
//   atomic claim → two concurrent approvals enrich a person once
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import type { ScoutFilterContext } from "./scoutFilters.ts";
import {
  countResolvedBatches, type EnrichDeps, type EnrichIO, enrichCandidate, normalizeEnrichIds, runEnrich,
  type ScoutCandidateRow,
} from "./scoutEnrich.ts";

const ID1 = "aaaaaaaa-0000-0000-0000-000000000001";
const ID2 = "aaaaaaaa-0000-0000-0000-000000000002";
const ANCHOR = "bbbbbbbb-0000-0000-0000-000000000001";
const NOW = new Date("2026-11-02T12:00:00Z");

const cand = (over: Partial<ScoutCandidateRow> = {}): ScoutCandidateRow => ({
  id: ID1, workspace_id: "ws1", owner_user_id: "rep1", contact_name: "Dana", company_domain: "acme.com",
  company_name: "Acme Pay", job_title: "VP Sales", linkedin_url: null, location: null,
  ai_reason: "Runs sales at a payments company", fit_label: "high", scout_batch_id: "run1",
  anchor_lead_id: ANCHOR, provider: "apollo", provider_person_id: "p1", ...over,
});

const emptyCtx = (over: Partial<ScoutFilterContext> = {}): ScoutFilterContext => ({
  leads: [], unsubscribedEmails: [], suppressedEmails: [], suppressedDomains: [], dismissedEmails: [],
  dismissedDomains: [], internalDomains: [], existingScoutCandidates: [], allowEu: false, ...over,
});

const person = (over: Record<string, unknown> = {}) => ({
  email: "dana.cohen@acme.com", email_status: "verified", linkedin_url: "https://www.linkedin.com/in/dana-cohen",
  first_name: "Dana", last_name: "Cohen", location: "Austin, Texas, United States",
  city: "Austin", state: "Texas", country: "United States", ...over,
});

function deps(over: { email?: string | null; ctx?: ScoutFilterContext; apolloError?: string; noLusha?: boolean; location?: string } = {}) {
  const calls = { apollo: 0, lusha: 0 };
  const d: EnrichDeps = {
    apollo: () => {
      calls.apollo++;
      if (over.apolloError) return Promise.resolve({ data: null, credits: 0, error: over.apolloError });
      const p = person({
        ...(over.email !== undefined ? { email: over.email } : {}),
        ...(over.location ? { location: over.location, country: "Germany" } : {}),
      });
      return Promise.resolve({ data: p as never, credits: 1, error: null });
    },
    lusha: over.noLusha ? null : () => {
      calls.lusha++;
      return Promise.resolve({ data: { phone: "+1 512 555 0100", phone_type: "mobile" }, credits: 1, error: null });
    },
    loadFilterContext: () => Promise.resolve(over.ctx ?? emptyCtx()),
    now: () => NOW,
  };
  return { d, calls };
}

const batch = { profile_id: "prof1", profile_sentence: "I'll look for VP Sales." };

Deno.test("no verified email → dismissed no_verified_email, Lusha never called", async () => {
  const { d, calls } = deps({ email: null });
  const out = await enrichCandidate(cand(), batch, d, []);
  assertEquals(out.kind, "dismissed");
  assertEquals(out.kind === "dismissed" && out.reason, "no_verified_email");
  assertEquals(out.apollo, 1);
  assertEquals(calls.lusha, 0);
});

Deno.test("invalid/junk email → dismissed invalid_email before Lusha", async () => {
  const { d, calls } = deps({ email: "info@acme.com" });
  const out = await enrichCandidate(cand(), batch, d, []);
  assertEquals(out.kind === "dismissed" && out.reason, "invalid_email");
  assertEquals(calls.lusha, 0);
});

Deno.test("blocked after enrichment → dismissed with the filter reason, no Lusha", async () => {
  const cases: Array<[Partial<ScoutFilterContext>, string, string?]> = [
    [{ unsubscribedEmails: ["dana.cohen@acme.com"] }, "unsubscribed"],
    [{ suppressedEmails: ["dana.cohen@acme.com"] }, "suppressed_email"],
    [{ suppressedDomains: ["acme.com"] }, "suppressed_domain"],
    [{ dismissedDomains: ["acme.com"] }, "dismissed_domain"],
    [{ internalDomains: ["acme.com"] }, "internal_domain"],
    [{ leads: [{ email: "Dana.Cohen@acme.com" }] }, "existing_lead"],
    [{ leads: [{ linkedin_url: "https://linkedin.com/in/Dana-Cohen/" }] }, "existing_lead"],
    [{}, "eu_location", "Berlin, Germany"],
  ];
  for (const [ctx, reason, location] of cases) {
    const { d, calls } = deps({ ctx: emptyCtx(ctx), location });
    const out = await enrichCandidate(cand(), batch, d, []);
    assertEquals(out.kind === "dismissed" && out.reason, reason, reason);
    assertEquals(calls.lusha, 0, `${reason}: no Lusha`);
  }
});

Deno.test("EU allowed → the EU person becomes a lead", async () => {
  const { d } = deps({ ctx: emptyCtx({ allowEu: true }), location: "Berlin, Germany" });
  assertEquals((await enrichCandidate(cand(), batch, d, [])).kind, "lead");
});

Deno.test("happy path → lead payload shape incl. raw_import_json.scout", async () => {
  const { d, calls } = deps();
  const out = await enrichCandidate(cand(), batch, d, []);
  assertEquals(calls, { apollo: 1, lusha: 1 });
  if (out.kind !== "lead") throw new Error("expected a lead");
  assertEquals(out.lead, {
    workspace_id: "ws1",
    owner_user_id: "rep1",
    name: "Dana Cohen",
    company: "Acme Pay",
    email: "dana.cohen@acme.com",
    phone: "+1 512 555 0100",
    job_title: "VP Sales",
    linkedin_url: "https://www.linkedin.com/in/dana-cohen",
    city: "Austin",
    state: "Texas",
    country: "United States",
    strategy: "fast",
    motion: "outbound_prospecting",
    source_type: "ai_scout",
    stage: "new",
    last_activity_at: NOW.toISOString(),
    raw_import_json: {
      scout: {
        reason: "Runs sales at a payments company",
        fit_label: "high",
        profile_sentence: "I'll look for VP Sales.",
        profile_id: "prof1",
        batch_id: "run1",
        anchor_lead_id: ANCHOR,
        provider: "apollo",
        provider_person_id: "p1",
        enriched_at: NOW.toISOString(),
        phone_provider: "lusha",
      },
    },
  });
  assertEquals([out.apollo, out.lusha], [1, 1]);
});

Deno.test("no Lusha key → lead without a phone", async () => {
  const { d } = deps({ noLusha: true });
  const out = await enrichCandidate(cand(), batch, d, []);
  if (out.kind !== "lead") throw new Error("expected a lead");
  assertEquals(out.lead.phone, null);
  assertEquals((out.lead.raw_import_json as { scout: { phone_provider: unknown } }).scout.phone_provider, null);
});

Deno.test("Apollo error with no credit spent → retry (revert to pending)", async () => {
  const { d, calls } = deps({ apolloError: "apollo enrich: HTTP 500" });
  const out = await enrichCandidate(cand(), batch, d, []);
  assertEquals(out.kind, "retry");
  assertEquals(calls.lusha, 0);
});

Deno.test("normalizeEnrichIds: uuids only, unique, capped", () => {
  assertEquals(normalizeEnrichIds([ID1, ID1, "x", 3, ID2], 100), [ID1, ID2]);
  assertEquals(normalizeEnrichIds(ID1), [ID1]);
  assertEquals(normalizeEnrichIds([ID1, ID2], 1), [ID1]);
});

/** In-memory lead_candidates honoring the conditional claim the edge function runs in SQL. */
function memoryIO(rows: ScoutCandidateRow[], opts: { leadError?: string; duplicate?: boolean } = {}) {
  const status = new Map(rows.map((r) => [r.id, "pending"]));
  const patches: Array<[string, Record<string, unknown>]> = [];
  const leads: Record<string, unknown>[] = [];
  const io: EnrichIO = {
    claim: async (ids) => {
      await Promise.resolve();
      // UPDATE … SET status='approved' WHERE id = ANY(ids) AND status='pending' RETURNING …
      return rows.filter((r) => ids.includes(r.id) && status.get(r.id) === "pending").map((r) => {
        status.set(r.id, "approved");
        return r;
      });
    },
    batchInfo: () => Promise.resolve(new Map([["run1", batch]])),
    createLead: (p) => {
      if (opts.duplicate) return Promise.resolve({ duplicate: true as const });
      if (opts.leadError) return Promise.resolve({ error: opts.leadError });
      leads.push(p);
      return Promise.resolve({ id: `lead${leads.length}` });
    },
    update: (id, patch) => {
      patches.push([id, patch]);
      if (typeof patch.status === "string") status.set(id, patch.status);
      return Promise.resolve();
    },
  };
  return { io, status, patches, leads };
}

Deno.test("atomic claim: two concurrent approvals of the same rows charge once", async () => {
  const { d, calls } = deps();
  const m = memoryIO([cand(), cand({ id: ID2, provider_person_id: "p2" })]);
  // Distinct people (email + name) so both become leads.
  let n = 0;
  d.apollo = () => {
    calls.apollo++;
    n++;
    return Promise.resolve({ data: person({ email: `dana${n}@acme.com`, first_name: `Dana${n}`, linkedin_url: null }) as never, credits: 1, error: null });
  };
  const [a, b] = await Promise.all([runEnrich([ID1, ID2], m.io, d), runEnrich([ID1, ID2], m.io, d)]);
  assertEquals(a.claimed + b.claimed, 2);
  assertEquals(calls.apollo, 2, "each person enriched exactly once");
  assertEquals(a.added + b.added, 2);
  assertEquals(m.leads.length, 2);
  // A third approve after resolution claims nothing and calls nobody.
  const c = await runEnrich([ID1, ID2], m.io, d);
  assertEquals([c.claimed, calls.apollo], [0, 2]);
});

Deno.test("runEnrich: same person twice in one call → second is existing_lead", async () => {
  const { d, calls } = deps();
  const m = memoryIO([cand(), cand({ id: ID2, provider_person_id: "p2" })]);
  const s = await runEnrich([ID1, ID2], m.io, d, 1);
  assertEquals([s.added, s.skipped_other, calls.lusha], [1, 1, 1]);
  assertEquals(m.status.get(ID2), "dismissed");
});

Deno.test("runEnrich: summary, credits, and the candidate patches", async () => {
  const { d } = deps({ email: null });
  const m = memoryIO([cand()]);
  const s = await runEnrich([ID1], m.io, d);
  assertEquals([s.added, s.skipped_no_email, s.apollo_credits, s.lusha_credits], [0, 1, 1, 0]);
  assertEquals(m.patches[0][1].status, "dismissed");
  assertEquals(m.patches[0][1].dismiss_reason, "no_verified_email");
});

Deno.test("runEnrich: lead insert failure reverts to pending; duplicate is final", async () => {
  const fail = memoryIO([cand()], { leadError: "boom" });
  const s1 = await runEnrich([ID1], fail.io, deps().d);
  assertEquals([s1.retry, fail.status.get(ID1)], [1, "pending"]);

  const dup = memoryIO([cand()], { duplicate: true });
  const s2 = await runEnrich([ID1], dup.io, deps().d);
  assertEquals([s2.skipped_other, dup.status.get(ID1)], [1, "dismissed"]);
});

Deno.test("runEnrich: a provider outage reverts every claimed row", async () => {
  const m = memoryIO([cand(), cand({ id: ID2, provider_person_id: "p2" })]);
  const s = await runEnrich([ID1, ID2], m.io, deps({ apolloError: "apollo enrich: HTTP 503" }).d);
  assertEquals([s.retry, m.status.get(ID1), m.status.get(ID2)], [2, "pending", "pending"]);
});

Deno.test("runEnrich: filter lookup throws after Apollo → retry, Apollo credit still counted, no Lusha", async () => {
  const { d, calls } = deps();
  d.loadFilterContext = () => Promise.reject(new Error("scout filter: opt-out lookup failed"));
  const m = memoryIO([cand()]);
  const s = await runEnrich([ID1], m.io, d);
  assertEquals([s.retry, s.apollo_credits, s.lusha_credits, calls.lusha], [1, 1, 0, 0]);
  assertEquals(m.status.get(ID1), "pending");
});

// approved_batches: counted once per batch, only once nothing is pending —
// whether it finished via scout-enrich or the weekly-run sweep (manual dismiss).
Deno.test("countResolvedBatches: once per fully-resolved batch, never while rows are pending", async () => {
  const st = { pending: 1, resolved: false, approved: 0 };
  // Minimal chainable stand-in for the three queries countResolvedBatches makes.
  const admin = {
    from(table: string) {
      let op = "select";
      const b: Record<string, unknown> = {};
      const result = () => {
        if (table === "lead_candidates") return { count: st.pending };
        if (table === "scout_runs") {
          if (st.resolved) return { data: [] };
          st.resolved = true;
          return { data: [{ profile_id: "prof1" }] };
        }
        if (op === "update") return { data: null, error: null, _: st.approved++ };
        return { data: { approved_batches: st.approved } };
      };
      for (const m of ["select", "eq", "is"]) b[m] = () => b;
      b.update = () => ((op = "update"), b);
      b.maybeSingle = () => Promise.resolve(result());
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
      return b;
    },
  };
  await countResolvedBatches(admin, "ws1", ["run1"]);
  assertEquals(st.approved, 0); // a card is still pending
  st.pending = 0;
  await countResolvedBatches(admin, "ws1", ["run1"]);
  await countResolvedBatches(admin, "ws1", ["run1"]); // sweep + enrich both see it
  assertEquals(st.approved, 1);
});
