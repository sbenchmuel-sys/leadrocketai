// Run: deno test --no-check --allow-net --allow-env supabase/functions/_shared/campaignMeetingCta.test.ts
//
// Per-rep meeting CTA (Outreach Unit 3) — the SEND-TIME injection. Cold campaign
// emails ship the workspace-SHARED campaign_step_content body, so the booking link
// is NEVER baked into stored content; resolveTouchContent appends the LEAD OWNER's
// OWN link at send. The load-bearing case (g) is cross-rep no-leak: rep A and rep B
// sending the same authored copy must each get their OWN link, never the other's.
import { assertEquals, assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { buildMeetingCtaLine, appendMeetingCta } from "./meetingCtaLine.ts";
import { resolveTouchContent } from "./coldOutreach.ts";

const LINK_A = "https://cal.example.com/rep-a";
const LINK_B = "https://cal.example.com/rep-b";
// The authored body is shared + contains NO link (only a name token).
const SHARED_BODY = "Hi {first_name}, quick thought on your rollout. Worth a chat?";

// ── pure helper ─────────────────────────────────────────────────────────────

Deno.test("appendMeetingCta: appends the link, null-safe, idempotent", () => {
  assertEquals(appendMeetingCta("Body.", null), "Body.");
  assertEquals(appendMeetingCta("Body.", "   "), "Body.");
  const out = appendMeetingCta("Body.", LINK_A);
  assert(out.includes(LINK_A));
  assert(out.startsWith("Body."));
  // idempotent — a re-resolve never double-appends
  assertEquals(appendMeetingCta(out, LINK_A), out);
  assert(buildMeetingCtaLine(LINK_A).includes(LINK_A));
});

// ── resolveTouchContent send-time injection ─────────────────────────────────

// deno-lint-ignore no-explicit-any
function makeClient(opts: { stepFlag: boolean | null; ownerLinks: Record<string, string | null> }): any {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => { filters[c] = v; return builder; },
        is: (c: string, v: unknown) => { filters[c] = v; return builder; },
        maybeSingle: () => {
          if (table === "campaign_steps") {
            return Promise.resolve({ data: { include_meeting_cta: opts.stepFlag }, error: null });
          }
          if (table === "rep_profiles") {
            return Promise.resolve({ data: { calendar_link: opts.ownerLinks[filters["user_id"] as string] ?? null }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        // campaign_step_content is awaited directly (no maybeSingle).
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: table === "campaign_step_content" ? [{ subject: "Hi", body: SHARED_BODY, variant_group: null }] : [], error: null }),
      };
      return builder;
    },
  };
}

async function bodyFor(stepFlag: boolean | null, owner: string | null, ownerLinks: Record<string, string | null>) {
  const c = makeClient({ stepFlag, ownerLinks });
  const out = await resolveTouchContent(c, "camp-1", 2, null, "Rita", owner);
  return out?.body ?? "";
}

Deno.test("force_on + owner has a link → the OWNER's link is appended", async () => {
  const body = await bodyFor(true, "rep-a", { "rep-a": LINK_A });
  assert(body.includes(LINK_A), "owner's link should be appended");
});

Deno.test("ISOLATION: each rep gets ONLY their own link from the SAME shared body (g)", async () => {
  const ownerLinks = { "rep-a": LINK_A, "rep-b": LINK_B };
  const aBody = await bodyFor(true, "rep-a", ownerLinks);
  const bBody = await bodyFor(true, "rep-b", ownerLinks);
  assert(aBody.includes(LINK_A) && !aBody.includes(LINK_B), "rep A gets only A's link");
  assert(bBody.includes(LINK_B) && !bBody.includes(LINK_A), "rep B gets only B's link");
  // The shared authored body itself carries NO link — proves nothing is baked in.
  assert(!SHARED_BODY.includes("http"));
});

Deno.test("null flag → no link appended (cold-send byte-unchanged)", async () => {
  const body = await bodyFor(null, "rep-a", { "rep-a": LINK_A });
  assert(!body.includes(LINK_A), "null must not add a link");
});

Deno.test("false flag → no link appended", async () => {
  const body = await bodyFor(false, "rep-a", { "rep-a": LINK_A });
  assert(!body.includes(LINK_A));
});

Deno.test("force_on but owner has NO link → CTA omitted cleanly (no placeholder)", async () => {
  const body = await bodyFor(true, "rep-a", { "rep-a": null });
  assertEquals(body.includes("http"), false);
  assertEquals(body.includes("grab a time"), false);
});

Deno.test("no ownerUserId → no link (defensive)", async () => {
  const body = await bodyFor(true, null, { "rep-a": LINK_A });
  assert(!body.includes(LINK_A));
});
