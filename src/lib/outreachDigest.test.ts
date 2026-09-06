import { describe, expect, it } from "vitest";
import { buildDigest, ROW_CAP } from "./outreachDigest";

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
