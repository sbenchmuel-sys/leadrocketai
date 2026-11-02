// Run: deno test supabase/functions/_shared/scoutGate.test.ts
// Opt-out lookups must fetch with the same identity filterScoutCandidates
// compares (normalizeEmail strips "+tag" and case): a plus-alias of a
// suppressed / dismissed / unsubscribed address is caught, and a merely
// similar address isn't. Stub client evaluates the ilike filters in memory.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { filterScoutCandidates } from "./scoutFilters.ts";
import { loadEnrichFilterContext } from "./scoutGate.ts";

const ilike = (pat: string) =>
  new RegExp(
    "^" + pat.replace(/\\(.)|([%*])|(_)|([.+?^${}()|[\]\\/])/g, (_m, esc, star, under, re) =>
      esc ? esc.replace(/[.+?^${}()|[\]\\/*]/g, "\\$&") : star ? ".*" : under ? "." : `\\${re}`) + "$",
    "i",
  );

// deno-lint-ignore no-explicit-any
function stubAdmin(tables: Record<string, Array<Record<string, any>>>) {
  return {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const preds: Array<(r: Record<string, any>) => boolean> = [];
      const q = {
        select: () => q,
        limit: () => q,
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
        ilike: (c: string, p: string) => (preds.push((r) => typeof r[c] === "string" && ilike(p).test(r[c])), q),
        or: (expr: string) => {
          const alts = expr.split(",").map((a) => {
            const [c, op, ...rest] = a.split(".");
            const v = rest.join(".");
            // deno-lint-ignore no-explicit-any
            return (r: Record<string, any>) => op === "is" ? r[c] == null : typeof r[c] === "string" && ilike(v).test(r[c]);
          });
          preds.push((r) => alts.some((f) => f(r)));
          return q;
        },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: (tables[table] ?? []).filter((r) => preds.every((p) => p(r))), error: null }).then(res),
      };
      return q;
    },
  };
}

const ctxFor = (email: string, tables: Parameters<typeof stubAdmin>[0]) =>
  loadEnrichFilterContext(stubAdmin(tables), "ws1", false, { email, linkedin_url: null, domains: ["acme.com"] });

const verdict = async (email: string, tables: Parameters<typeof stubAdmin>[0]) => {
  const stub = { provider: "apollo", provider_person_id: "p1", email, company_domain: "acme.com" };
  return filterScoutCandidates([stub], await ctxFor(email, tables)).dropped[0]?.reason ?? "kept";
};

Deno.test("plus-alias of a suppressed address is fetched and filtered (both directions, any case)", async () => {
  const sup = { campaign_suppression_list: [{ workspace_id: "ws1", kind: "email", value: "Person@Acme.com" }] };
  assertEquals(await verdict("person+tag@acme.com", sup), "suppressed_email");
  const supAlias = { campaign_suppression_list: [{ workspace_id: "ws1", kind: "email", value: "person+old@acme.com" }] };
  assertEquals(await verdict("person@acme.com", supAlias), "suppressed_email");
  // Similar-but-different local part is NOT the same identity.
  assertEquals(await verdict("personal@acme.com", sup), "kept");
  // Another workspace's suppression never applies.
  assertEquals(
    await verdict("person+tag@acme.com", { campaign_suppression_list: [{ ...sup.campaign_suppression_list[0], workspace_id: "ws2" }] }),
    "kept",
  );
});

Deno.test("plus-alias of a dismissed / unsubscribed address is filtered", async () => {
  assertEquals(
    await verdict("person+x@acme.com", { workspace_dismissed_emails: [{ workspace_id: "ws1", email: "person@acme.com" }] }),
    "dismissed_email",
  );
  assertEquals(
    await verdict("person+x@acme.com", {
      leads: [{ workspace_id: "ws1", email: "PERSON@acme.com", linkedin_url: null, name: "P", unsubscribed: true }],
    }),
    "unsubscribed",
  );
});
