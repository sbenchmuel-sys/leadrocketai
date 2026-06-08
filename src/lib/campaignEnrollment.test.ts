import { describe, expect, it } from "vitest";
import {
  nextBusinessDay,
  addBusinessDays,
  businessDayOffset,
  cumulativeBusinessOffsets,
  emailOffsets,
  computeStaggeredStarts,
  computeCapacityPlan,
  summarizeChannelSkips,
  buildTouchSchedule,
  canReceiveChannel,
  type CadenceStep,
  type LeadContactInfo,
} from "./campaignEnrollment";

// A representative cadence: 3 emails + a call + a text (matches the default plan shape).
const STEPS: CadenceStep[] = [
  { step_number: 1, channel: "email", delay_days: 0 },
  { step_number: 2, channel: "email", delay_days: 3 },
  { step_number: 3, channel: "voice", delay_days: 2 },
  { step_number: 4, channel: "email", delay_days: 3 },
  { step_number: 5, channel: "sms", delay_days: 2 },
];

describe("business-day helpers", () => {
  it("nextBusinessDay snaps weekends forward to Monday", () => {
    const sat = new Date("2026-06-06T12:00:00Z"); // Saturday
    const sun = new Date("2026-06-07T12:00:00Z"); // Sunday
    const mon = new Date("2026-06-08T12:00:00Z"); // Monday
    expect(nextBusinessDay(sat).getUTCDate()).toBe(8);
    expect(nextBusinessDay(sun).getUTCDate()).toBe(8);
    expect(nextBusinessDay(mon).getUTCDate()).toBe(8);
  });

  it("addBusinessDays skips weekends — Fri + 1 = Mon", () => {
    const fri = new Date("2026-06-05T12:00:00Z"); // Friday
    const result = addBusinessDays(fri, 1);
    expect(result.getUTCDay()).toBe(1); // Monday
    expect(result.getUTCDate()).toBe(8);
  });

  it("addBusinessDays(d, 0) returns the same business day", () => {
    const wed = new Date("2026-06-03T12:00:00Z");
    expect(addBusinessDays(wed, 0).getUTCDate()).toBe(3);
  });
});

describe("businessDayOffset", () => {
  it("buckets a same-day-but-later touch as offset 0 (date-only compare)", () => {
    const anchor = new Date("2026-06-03T09:00:00Z"); // Wed 9am
    const laterSameDay = new Date("2026-06-03T17:00:00Z"); // Wed 5pm
    expect(businessDayOffset(anchor, laterSameDay)).toBe(0);
  });
  it("counts business days and skips the weekend", () => {
    const fri = new Date("2026-06-05T09:00:00Z");
    const mon = new Date("2026-06-08T15:00:00Z"); // next business day, later time
    expect(businessDayOffset(fri, mon)).toBe(1);
  });
  it("maps past dates to 0", () => {
    const anchor = new Date("2026-06-10T09:00:00Z");
    const past = new Date("2026-06-01T09:00:00Z");
    expect(businessDayOffset(anchor, past)).toBe(0);
  });
});

describe("cadence offsets", () => {
  it("cumulative offsets sum the gaps, touch 1 at 0", () => {
    expect(cumulativeBusinessOffsets(STEPS)).toEqual([0, 3, 5, 8, 10]);
  });

  it("emailOffsets keeps only the email touches", () => {
    // email touches are steps 1,2,4 → offsets 0,3,8
    expect(emailOffsets(STEPS)).toEqual([0, 3, 8]);
  });
});

describe("computeStaggeredStarts", () => {
  it("never exceeds the daily cap on any email-touch day", () => {
    const offsets = [0, 3, 8]; // 3 email touches
    const cap = 5;
    const leadCount = 50;
    const starts = computeStaggeredStarts(leadCount, offsets, cap);
    expect(starts).toHaveLength(leadCount);

    // Reconstruct the per-day email load and assert it's within cap.
    const load: Record<number, number> = {};
    for (const s of starts) for (const o of offsets) load[s + o] = (load[s + o] ?? 0) + 1;
    for (const day of Object.keys(load)) {
      expect(load[Number(day)]).toBeLessThanOrEqual(cap);
    }
  });

  it("assigns every lead a start day", () => {
    const starts = computeStaggeredStarts(37, [0, 2, 5], 6);
    expect(starts).toHaveLength(37);
    expect(starts.every((s) => Number.isInteger(s) && s >= 0)).toBe(true);
  });

  it("starts everyone on day 0 when there are no email touches", () => {
    const starts = computeStaggeredStarts(20, [], 40);
    expect(starts).toEqual(new Array(20).fill(0));
  });

  it("dribbles starts when the list is larger than the cap", () => {
    // 1 email touch, cap 10 → 10 start day 0, next 10 day 1, ...
    const starts = computeStaggeredStarts(25, [0], 10);
    expect(starts.filter((s) => s === 0)).toHaveLength(10);
    expect(starts.filter((s) => s === 1)).toHaveLength(10);
    expect(starts.filter((s) => s === 2)).toHaveLength(5);
  });

  it("seeds existing load so new starts avoid days already at cap", () => {
    // 1 email touch at offset 0, cap 2, day 0 already has 2 booked (existing
    // enrollments' follow-ups) → both new starts shift to day 1.
    const starts = computeStaggeredStarts(2, [0], 2, { 0: 2 });
    expect(starts).toEqual([1, 1]);
  });

  it("respects the cap when an offset repeats (two emails land on the same day)", () => {
    // offsets [0, 0] = two email touches on the start day; cap 4 → each lead adds 2,
    // so at most 2 leads/day. The naive (per-offset +1) check would have allowed 4.
    const starts = computeStaggeredStarts(3, [0, 0], 4);
    expect(starts.filter((s) => s === 0)).toHaveLength(2);
    expect(starts.filter((s) => s === 1)).toHaveLength(1);
  });

  it("spreads one lead per day when a single lead's touches exceed the cap (infeasible cadence)", () => {
    // Two day-0 email steps with cap 1 → even ONE lead overflows day 0; the cap is
    // structurally unsatisfiable. The schedule must NOT pile every lead onto one day
    // (the old fallback) — one lead per business day is the least-bad spread.
    const starts = computeStaggeredStarts(3, [0, 0], 1);
    expect(starts).toEqual([0, 1, 2]);
    expect(new Set(starts).size).toBe(starts.length); // overflow never stacked
  });

  it("never stacks different leads when the infeasible offset is not day 0 ([0,1,1])", () => {
    // offsets [0,1,1] cap 1 → each lead puts 2 emails on its OWN day+1 (unavoidable),
    // but no OTHER lead's touch may land on that same day. Booking each placed lead
    // into the load and skipping full days achieves that.
    const starts = computeStaggeredStarts(3, [0, 1, 1], 1);
    const owners: Record<number, Set<number>> = {};
    starts.forEach((s, lead) => {
      for (const o of [0, 1, 1]) (owners[s + o] ??= new Set()).add(lead);
    });
    // No day mixes touches from more than one lead.
    for (const day of Object.keys(owners)) expect(owners[Number(day)].size).toBe(1);
  });

  it("respects seeded-full days even for an infeasible cadence", () => {
    // [0,0] cap 1 is infeasible; days 0 and 1 are already full from existing touches.
    // New leads must skip the seeded-full days, not pile onto day 0 (which the
    // load-ignoring early return used to do).
    const seeded = { 0: 1, 1: 1 };
    const starts = computeStaggeredStarts(2, [0, 0], 1, seeded);
    expect(starts).toEqual([2, 3]);
  });

  it("searches past seeded full days instead of overflowing one (running outreach)", () => {
    // cap 1, days 0–5 already full from existing touches; 1 new lead, 1 email touch.
    // The new start must land on day 6 (first day with room), not overflow a full day.
    const seeded = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 };
    const starts = computeStaggeredStarts(1, [0], 1, seeded);
    expect(starts).toEqual([6]);
    const load: Record<number, number> = { ...seeded };
    load[starts[0]] = (load[starts[0]] ?? 0) + 1;
    expect(load[starts[0]]).toBeLessThanOrEqual(1); // never over cap
  });
});

describe("computeCapacityPlan", () => {
  it("matches the brief's example (300 × 3 @ 40 → ~13/day, ~23 days)", () => {
    const plan = computeCapacityPlan({ leadCount: 300, emailTouchesPerLead: 3, dailyCap: 40 });
    expect(plan.startsPerDay).toBe(13); // floor(40/3)
    expect(plan.daysToStartEveryone).toBe(24); // ceil(300/13) = 24
    expect(plan.summary).toContain("about 13 begin per day");
    expect(plan.overCapacity).toBe(true); // 24 > 20 → warn
    expect(plan.warning).toBeTruthy();
  });

  it("does not warn for a comfortably-sized list", () => {
    const plan = computeCapacityPlan({ leadCount: 40, emailTouchesPerLead: 3, dailyCap: 40 });
    expect(plan.overCapacity).toBe(false);
    expect(plan.warning).toBeNull();
  });

  it("flags over-capacity when the cap can't fit one lead's emails", () => {
    const plan = computeCapacityPlan({ leadCount: 10, emailTouchesPerLead: 5, dailyCap: 3 });
    expect(plan.overCapacity).toBe(true);
  });

  it("no auto-emails → everyone begins at once", () => {
    const plan = computeCapacityPlan({ leadCount: 100, emailTouchesPerLead: 0, dailyCap: 40 });
    expect(plan.daysToStartEveryone).toBe(1);
    expect(plan.startsPerDay).toBe(100);
    expect(plan.warning).toBeNull();
  });
});

describe("summarizeChannelSkips", () => {
  const leads: LeadContactInfo[] = [
    { id: "a", email: "a@x.com", phone: "+1", linkedin_url: "u", whatsapp_number: null },
    { id: "b", email: "b@x.com", phone: null, linkedin_url: null, whatsapp_number: null },
    { id: "c", email: "c@x.com", phone: null, linkedin_url: "u", whatsapp_number: null },
  ];

  it("counts leads that can't receive each manual channel", () => {
    const summary = summarizeChannelSkips(leads, STEPS); // uses voice + sms
    expect(summary.byChannel.voice).toBe(2); // b and c have no phone
    expect(summary.byChannel.sms).toBe(2);
    expect(summary.lines.some((l) => l.includes("2 of 3") && l.includes("call"))).toBe(true);
  });

  it("never reports email as a skip channel", () => {
    const summary = summarizeChannelSkips(leads, [{ step_number: 1, channel: "email", delay_days: 0 }]);
    expect(summary.byChannel.email).toBeUndefined();
    expect(summary.lines).toHaveLength(0);
  });

  it("canReceiveChannel honors whatsapp fallback to phone", () => {
    const lead: LeadContactInfo = { id: "d", email: "d@x.com", phone: "+1", linkedin_url: null, whatsapp_number: null };
    expect(canReceiveChannel(lead, "whatsapp")).toBe(true); // falls back to phone
    expect(canReceiveChannel(lead, "linkedin")).toBe(false);
  });
});

describe("buildTouchSchedule", () => {
  // Start on a Wednesday so we can see weekend skipping in the later touches.
  const start = new Date("2026-06-03T09:00:00Z"); // Wed

  it("spaces touches by business-day gaps, touch 1 on the start day", () => {
    const schedule = buildTouchSchedule(start, STEPS);
    expect(schedule).toHaveLength(5);
    expect(new Date(schedule[0].eligible_at).getUTCDate()).toBe(3); // Wed (touch 1)
    // Each subsequent eligible_at must be a business day and strictly later.
    for (let i = 1; i < schedule.length; i++) {
      const d = new Date(schedule[i].eligible_at);
      expect(d.getUTCDay()).not.toBe(0);
      expect(d.getUTCDay()).not.toBe(6);
      expect(d.getTime()).toBeGreaterThan(new Date(schedule[i - 1].eligible_at).getTime());
    }
  });

  it("sets max_age_at on manual touches and leaves email touches null", () => {
    const schedule = buildTouchSchedule(start, STEPS);
    const email = schedule.filter((t) => t.channel === "email");
    const manual = schedule.filter((t) => t.channel !== "email");
    expect(email.every((t) => t.max_age_at === null)).toBe(true);
    expect(manual.every((t) => t.max_age_at !== null)).toBe(true);
  });

  it("a 0-day gap after a manual touch gives a 1-day max-age, not a 5-day stall", () => {
    // Manual call (step 1) immediately followed by a same-day step (delay_days 0).
    // The manual touch's auto-skip horizon must be 1 business day, not balloon to the
    // 5-day default (the old `nextGap || DEFAULT` bug treated 0 as missing).
    const steps: CadenceStep[] = [
      { step_number: 1, channel: "voice", delay_days: 0 },
      { step_number: 2, channel: "email", delay_days: 0 },
    ];
    const wed = new Date("2026-06-03T09:00:00Z"); // Wed (no weekend skip)
    const schedule = buildTouchSchedule(wed, steps);
    const call = schedule[0];
    // eligible Wed the 3rd; +1 business day = Thu the 4th.
    expect(new Date(call.eligible_at).getUTCDate()).toBe(3);
    expect(new Date(call.max_age_at as string).getUTCDate()).toBe(4);
  });
});
