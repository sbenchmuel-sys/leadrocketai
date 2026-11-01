// Run: deno test supabase/functions/_shared/scoutWeekly.test.ts
// Weekly run decisions: workspace-tz clock, due slot, one batch per week,
// cap shared across reps, AI ranking validation.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  allocate, canAttempt, failedSlotKey, isSlotReached, localClock, parseRankPicks, weekKey, weekStartIso,
} from "./scoutWeekly.ts";

const MON_7AM = { delivery_dow: 1, delivery_hour: 7 };

Deno.test("localClock reads the workspace tz, not UTC", () => {
  // 2026-11-02 11:30Z = Monday 06:30 in New York (EST, UTC-5).
  const ny = localClock(new Date("2026-11-02T11:30:00Z"), "America/New_York");
  assertEquals([ny.dow, ny.hour, ny.minute], [1, 6, 30]);
  // Same instant is Monday 13:30 in Jerusalem (IST, UTC+2).
  const jlm = localClock(new Date("2026-11-02T11:30:00Z"), "Asia/Jerusalem");
  assertEquals([jlm.dow, jlm.hour], [1, 13]);
});

Deno.test("localClock falls back to New York on a null or bogus tz", () => {
  const now = new Date("2026-11-02T11:30:00Z");
  assertEquals(localClock(now, null).tz, "America/New_York");
  assertEquals(localClock(now, "Not/AZone").tz, "America/New_York");
});

Deno.test("isSlotReached: Monday 7am in workspace tz", () => {
  const at = (iso: string, tz = "America/New_York") => isSlotReached(MON_7AM, localClock(new Date(iso), tz));
  assertEquals(at("2026-11-02T11:59:00Z"), false, "Mon 06:59 NY — not yet");
  assertEquals(at("2026-11-02T12:00:00Z"), true, "Mon 07:00 NY");
  assertEquals(at("2026-11-04T03:00:00Z"), true, "Tue night — still this week, catch up");
  // Sun Nov 1 23:00 NY belongs to the week of Oct 26, whose Monday slot has passed
  // (the weekKey claim stops a second batch for that week).
  assertEquals(at("2026-11-02T04:00:00Z"), true, "Sun 23:00 NY — end of the previous week");
});

Deno.test("isSlotReached: Sunday delivery is the last day of the Monday-start week", () => {
  const sun9 = { delivery_dow: 0, delivery_hour: 9 };
  assertEquals(isSlotReached(sun9, localClock(new Date("2026-11-07T15:00:00Z"), "UTC")), false, "Sat");
  assertEquals(isSlotReached(sun9, localClock(new Date("2026-11-08T09:00:00Z"), "UTC")), true, "Sun 09:00");
});

Deno.test("weekKey is the workspace-local Monday, across tz and day boundaries", () => {
  // Sunday 2026-11-08 23:30 NY = Monday 04:30Z: still the week of Nov 2 in NY.
  assertEquals(weekKey(localClock(new Date("2026-11-09T04:30:00Z"), "America/New_York")), "2026-11-02");
  assertEquals(weekKey(localClock(new Date("2026-11-09T04:30:00Z"), "UTC")), "2026-11-09");
  // Month boundary.
  assertEquals(weekKey(localClock(new Date("2026-12-02T12:00:00Z"), "UTC")), "2026-11-30");
});

Deno.test("weekStartIso: Monday 00:00 local", () => {
  const now = new Date("2026-11-04T17:45:12.345Z"); // Wed 12:45:12 NY
  assertEquals(weekStartIso(now, localClock(now, "America/New_York")), "2026-11-02T05:00:00.000Z");
});

Deno.test("canAttempt: three failed tries per week, then stop", () => {
  assertEquals([0, 1, 2, 3].map(canAttempt), [true, true, true, false]);
  assertEquals(failedSlotKey("2026-11-02", "r1"), "2026-11-02:failed:r1");
});

Deno.test("allocate: workspace cap shared across reps, in order", () => {
  // cap 50: rep A wants 25, rep B 25, rep C 10.
  let used = 0;
  const got = [25, 25, 10].map((target) => {
    const n = allocate(50, used, target);
    used += n;
    return n;
  });
  assertEquals(got, [25, 25, 0]);
  assertEquals(allocate(50, 45, 25), 5);
  assertEquals(allocate(50, 60, 25), 0, "over cap never negative");
  assertEquals(allocate(0, 0, 25), 0, "cap 0 = nothing");
});

const stubs = [{ provider_person_id: "a" }, { provider_person_id: "b" }, { provider_person_id: "c" }];
const ANCHOR = "11111111-1111-1111-1111-111111111111";

Deno.test("parseRankPicks validates ids, fit_label and anchors", () => {
  const picks = parseRankPicks({
    picks: [
      { id: "b", reason: "  VP Sales at a payments firm ", fit_label: "high", anchor_lead_id: ANCHOR },
      { id: "zzz", reason: "invented" },
      { id: "b", reason: "dup" },
      { id: "a", reason: "", fit_label: "excellent", anchor_lead_id: "22222222-2222-2222-2222-222222222222" },
      { id: "c", reason: "third" },
    ],
  }, stubs, 2, [ANCHOR])!;
  assertEquals(picks.map((p) => [p.stub.provider_person_id, p.fit_label, p.anchor_lead_id]), [
    ["b", "high", ANCHOR],
    ["a", "good", null],
  ]);
  assertEquals(picks[0].reason, "VP Sales at a payments firm");
  assertEquals(picks[1].reason.length > 0, true, "empty reason → fallback");
});

Deno.test("parseRankPicks: malformed output → null (fail closed); empty picks stay empty", () => {
  assertEquals(parseRankPicks(null, stubs, 5, []), null);
  assertEquals(parseRankPicks({ picks: "a" }, stubs, 5, []), null);
  assertEquals(parseRankPicks({ picks: [] }, stubs, 5, []), []);
});
