import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDigest, fetchOutreachDigest, ROW_CAP } from "./outreachDigest";

// A fake PostgREST client: every builder method chains, and awaiting the chain
// resolves whatever `resultFor` says that table should return. Lets us assert
// what fetchOutreachDigest does with `{ data: null, error }` — the shape
// supabase-js resolves with (it does NOT throw) when a read fails.
const resultFor: Record<string, { data: unknown; count?: number | null; error: unknown }> = {};
function builder(table: string): unknown {
  const target = () => undefined;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        const res = resultFor[table] ?? { data: [], count: 0, error: null };
        return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(res).then(ok, bad);
      }
      return () => builder(table);
    },
  });
}
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => builder(table) },
}));

describe("buildDigest — the Outreach tab's daily digest", () => {
  it("counts only NEXT-IN-LINE touches of live enrollments as 'later today'", () => {
    const d = buildDigest({
      scheduledToday: [
        { channel: "voice", step_number: 4, current_step_number: 3, enrollment_status: "active" },    // next in line
        { channel: "email", step_number: 5, current_step_number: 3, enrollment_status: "active" },    // two ahead — pre-created, not due
        { channel: "sms", step_number: 1, current_step_number: 0, enrollment_status: "scheduled" },   // first touch of a fresh enrollment
        { channel: "linkedin", step_number: 2, current_step_number: 1, enrollment_status: "replied" },// enrollment ended
      ],
      overdueByChannel: { email: 0, voice: 0, sms: 0, whatsapp: 0, linkedin: 0 },
      skipNotes: [],
    });
    expect(d.laterToday).toEqual({ email: 0, voice: 1, sms: 1, whatsapp: 0, linkedin: 0 });
  });

  it("totals the exact per-channel overdue counts", () => {
    const d = buildDigest({
      scheduledToday: [],
      overdueByChannel: { email: 0, voice: 2, sms: 0, whatsapp: 0, linkedin: 1 },
      skipNotes: [],
    });
    expect(d.overdue.voice).toBe(2);
    expect(d.overdueTotal).toBe(3);
    expect(d.laterTodayTruncated).toBe(false);
    expect(d.skippedYesterdayTruncated).toBe(false);
  });

  it("flags a capped read as truncated instead of passing it off as exact", () => {
    const d = buildDigest({
      scheduledToday: Array.from({ length: ROW_CAP }, () => ({ channel: "voice", step_number: 1, current_step_number: 0, enrollment_status: "scheduled" })),
      overdueByChannel: { email: 0, voice: 0, sms: 0, whatsapp: 0, linkedin: 0 },
      skipNotes: Array.from({ length: ROW_CAP }, () => ({ reason: "r", lead_name: null })),
    });
    expect(d.laterTodayTruncated).toBe(true);
    expect(d.skippedYesterdayTruncated).toBe(true);
  });

  it("groups yesterday's auto-skips by reason, biggest first, with a few names each", () => {
    const missing = "this lead has no LinkedIn profile on file";
    const expired = "the step's window passed before anyone acted on it";
    const d = buildDigest({
      scheduledToday: [],
      overdueByChannel: { email: 0, voice: 0, sms: 0, whatsapp: 0, linkedin: 0 },
      skipNotes: [
        { reason: expired, lead_name: "Ann" },
        { reason: missing, lead_name: "Bob" },
        { reason: missing, lead_name: "Cy" },
        { reason: missing, lead_name: "Dee" },
        { reason: missing, lead_name: "Eve" },
        { reason: missing, lead_name: "Bob" }, // same person twice → one name
        { reason: null, lead_name: "Old note" }, // pre-reason note → default wording
      ],
    });
    expect(d.skippedYesterdayTotal).toBe(7);
    expect(d.skippedYesterday.map((g) => [g.reason, g.count])).toEqual([
      [missing, 5], [expired, 1], ["the step's window passed", 1],
    ]);
    expect(d.skippedYesterday[0].leadNames).toEqual(["Bob", "Cy", "Dee"]);
  });
});

describe("fetchOutreachDigest — a failed read never folds into a confident zero", () => {
  beforeEach(() => {
    for (const k of Object.keys(resultFor)) delete resultFor[k];
  });

  it("throws when the campaigns read errors, instead of reporting an empty day", async () => {
    resultFor.campaigns = { data: null, error: { message: "connection reset" } };
    await expect(fetchOutreachDigest("UTC")).rejects.toThrow(/connection reset/);
  });

  it("throws when a touch/notes read errors, instead of '0 overdue — you're caught up'", async () => {
    resultFor.campaigns = { data: [{ id: "c1" }], error: null };
    resultFor.campaign_touch = { data: null, count: null, error: { message: "statement timeout" } };
    await expect(fetchOutreachDigest("UTC")).rejects.toThrow(/statement timeout/);
  });

  it("throws when the skip-notes read errors", async () => {
    resultFor.campaigns = { data: [{ id: "c1" }], error: null };
    resultFor.campaign_touch = { data: [], count: 0, error: null };
    resultFor.lead_timeline_items = { data: null, error: { message: "notes boom" } };
    await expect(fetchOutreachDigest("UTC")).rejects.toThrow(/notes boom/);
  });

  it("still reads yesterday's skip notes when NO campaign is active today", async () => {
    resultFor.campaigns = { data: [], error: null };
    resultFor.lead_timeline_items = {
      data: [{ metadata_json: { auto_skip_reason: "they hadn't accepted the invite" }, leads: { name: "Ann" } }],
      error: null,
    };
    const d = await fetchOutreachDigest("UTC");
    expect(d.skippedYesterdayTotal).toBe(1);
    expect(d.skippedYesterday[0].leadNames).toEqual(["Ann"]);
    expect(d.overdueTotal).toBe(0);
  });
});
