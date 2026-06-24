// Run: deno test --no-check supabase/functions/_shared/campaignMeetingCta.test.ts
//
// Covers the AUTHORING-PREVIEW side of the per-step meeting CTA (Unit 3):
// resolveCampaignAuthoringInstruction must thread ONLY the REQUESTING rep's own
// rep_profiles.calendar_link (per-rep, fail-closed — never another rep's), make
// the SAME per-step decision the live send makes, and omit the CTA cleanly when
// there's no link. The cross-rep no-leak case (g) is the load-bearing one.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { resolveCampaignAuthoringInstruction } from "./aiCampaignResolver.ts";

const WS = "ws-1";
const REP_A = "rep-A";
const REP_B = "rep-B";
const LINK_A = "https://cal.example.com/rep-a";
const LINK_B = "https://cal.example.com/rep-b";

interface MockOpts {
  members: string[]; // user_ids that are members of WS
  repLinks: Record<string, string | null>; // user_id → calendar_link
  step2Flag: boolean | null; // include_meeting_cta on the email step we author
  step2Channel?: string;
}

// Minimal chainable mock of the supabase-js builder for the queries this resolver
// makes: campaigns (meta + full row), workspace_members, campaign_steps (.order),
// rep_profiles. knowledge_document_id is null so the KB validation short-circuits.
// deno-lint-ignore no-explicit-any
function makeClient(opts: MockOpts): any {
  const campaignRow = {
    id: "camp-1",
    workspace_id: WS,
    motion: "outbound_prospecting",
    default_channel: "email",
    include_meeting_cta: false,
    global_instructions: null,
    knowledge_document_id: null,
    status: "draft",
  };
  const steps = [
    { step_number: 1, step_type: "intro", channel: "email", framework: null, objective: null, cta_type: "question", max_word_count: null, hard_rules: [], generation_hints: [], custom_instructions: null, delay_days: 0, active: true, variant_group: null, include_meeting_cta: null },
    { step_number: 2, step_type: "followup", channel: opts.step2Channel ?? "email", framework: null, objective: null, cta_type: "question", max_word_count: null, hard_rules: [], generation_hints: [], custom_instructions: null, delay_days: 2, active: true, variant_group: null, include_meeting_cta: opts.step2Flag },
    { step_number: 3, step_type: "breakup", channel: "email", framework: null, objective: null, cta_type: "breakup_close", max_word_count: null, hard_rules: [], generation_hints: [], custom_instructions: null, delay_days: 4, active: true, variant_group: null, include_meeting_cta: null },
  ];

  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        limit: () => builder,
        order: () => Promise.resolve({ data: steps, error: null }),
        maybeSingle: () => {
          if (table === "campaigns") return Promise.resolve({ data: campaignRow, error: null });
          if (table === "workspace_members") {
            const ok = filters["workspace_id"] === WS && opts.members.includes(filters["user_id"] as string);
            return Promise.resolve({ data: ok ? { user_id: filters["user_id"] } : null, error: null });
          }
          if (table === "rep_profiles") {
            const link = opts.repLinks[filters["user_id"] as string] ?? null;
            return Promise.resolve({ data: { calendar_link: link }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

async function authorStep2(client: unknown, userId: string) {
  return await resolveCampaignAuthoringInstruction(
    // deno-lint-ignore no-explicit-any
    client as any,
    "camp-1",
    2, // step number
    null, // industry
    userId,
  );
}

// ── (g) cross-rep no-leak — the load-bearing case ───────────────────────────

Deno.test("ISOLATION: each rep previews ONLY their own booking link", async () => {
  const client = makeClient({
    members: [REP_A, REP_B],
    repLinks: { [REP_A]: LINK_A, [REP_B]: LINK_B },
    step2Flag: true,
  });
  const asA = await authorStep2(client, REP_A);
  const asB = await authorStep2(client, REP_B);
  assertEquals(asA?.meetingLink, LINK_A); // rep A sees A's link
  assertEquals(asB?.meetingLink, LINK_B); // rep B sees B's link
  // Never the other rep's link.
  assertEquals(asA?.meetingLink === LINK_B, false);
  assertEquals(asB?.meetingLink === LINK_A, false);
});

// ── (c) rep with no calendar_link → CTA omitted cleanly ─────────────────────

Deno.test("no calendar link → meetingLink null (no placeholder), even when flagged on", async () => {
  const client = makeClient({
    members: [REP_A],
    repLinks: { [REP_A]: null },
    step2Flag: true,
  });
  const out = await authorStep2(client, REP_A);
  assertEquals(out?.meetingLink, null);
});

// ── decision parity: false off, null on (matches live) ──────────────────────

Deno.test("explicit false → link withheld in the preview", async () => {
  const client = makeClient({ members: [REP_A], repLinks: { [REP_A]: LINK_A }, step2Flag: false });
  const out = await authorStep2(client, REP_A);
  assertEquals(out?.meetingLink, null);
});

Deno.test("null flag → link threaded (preview matches live's default-on)", async () => {
  const client = makeClient({ members: [REP_A], repLinks: { [REP_A]: LINK_A }, step2Flag: null });
  const out = await authorStep2(client, REP_A);
  assertEquals(out?.meetingLink, LINK_A);
});

// ── non-email step flagged → ignored ────────────────────────────────────────

Deno.test("a non-email step flagged on never previews a booking link", async () => {
  const client = makeClient({
    members: [REP_A],
    repLinks: { [REP_A]: LINK_A },
    step2Flag: true,
    step2Channel: "voice",
  });
  const out = await authorStep2(client, REP_A);
  assertEquals(out?.meetingLink, null);
});

// ── fail-closed: a non-member gets nothing at all ───────────────────────────

Deno.test("ISOLATION: a non-member of the workspace gets null (no link, no instruction)", async () => {
  const client = makeClient({
    members: [REP_A], // REP_B is NOT a member here
    repLinks: { [REP_A]: LINK_A, [REP_B]: LINK_B },
    step2Flag: true,
  });
  const out = await authorStep2(client, REP_B);
  assertEquals(out, null);
});
