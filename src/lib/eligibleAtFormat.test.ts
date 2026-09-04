import { describe, expect, it } from "vitest";
import {
  formatEligibleAtAbsolute,
  formatEligibleAtRelative,
  formatEligibleAt,
  formatDueAt,
} from "./eligibleAtFormat";

const NOW = new Date("2026-05-21T14:00:00Z"); // 10:00 EDT, 15:00 BST

describe("formatEligibleAtAbsolute", () => {
  it("renders workspace-local time, not browser time", () => {
    // Same UTC instant rendered in two TZs must differ.
    const iso = "2026-05-21T18:00:00Z"; // 4h from NOW
    const ny = formatEligibleAtAbsolute(iso, "America/New_York", NOW);
    const ldn = formatEligibleAtAbsolute(iso, "Europe/London", NOW);
    expect(ny).not.toEqual(ldn);
    expect(ny).toContain("2:00"); // 14:00 EDT
    expect(ldn).toContain("7:00"); // 19:00 BST
  });

  it("omits weekday when target is within 24h", () => {
    const iso = "2026-05-21T20:00:00Z"; // 6h from NOW, same day
    const out = formatEligibleAtAbsolute(iso, "America/New_York", NOW);
    expect(out).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });

  it("includes weekday for 1-7 day range", () => {
    const iso = "2026-05-23T18:00:00Z"; // ~2 days out
    const out = formatEligibleAtAbsolute(iso, "America/New_York", NOW);
    expect(out).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });

  it("includes date for >7 days out", () => {
    const iso = "2026-06-15T18:00:00Z"; // ~25 days
    const out = formatEligibleAtAbsolute(iso, "America/New_York", NOW);
    expect(out).toMatch(/Jun/);
  });

  it("falls back to UTC when timezone is null", () => {
    const iso = "2026-05-21T20:00:00Z";
    const out = formatEligibleAtAbsolute(iso, null, NOW);
    expect(out).toContain("8:00"); // 20:00 UTC
  });

  it("falls back to UTC when timezone is garbage", () => {
    const iso = "2026-05-21T20:00:00Z";
    const out = formatEligibleAtAbsolute(iso, "Not/A_Real_Zone", NOW);
    expect(out).toContain("8:00"); // 20:00 UTC
  });

  it("returns empty string for empty/invalid iso", () => {
    expect(formatEligibleAtAbsolute("", "UTC", NOW)).toBe("");
    expect(formatEligibleAtAbsolute(null, "UTC", NOW)).toBe("");
    expect(formatEligibleAtAbsolute("not-a-date", "UTC", NOW)).toBe("");
  });
});

describe("formatEligibleAtRelative", () => {
  it("formats future as 'Fires in Xh'", () => {
    const iso = "2026-05-21T17:00:00Z"; // +3h
    expect(formatEligibleAtRelative(iso, NOW)).toBe("Fires in 3h");
  });

  it("formats future as 'Fires in Xd' beyond a day", () => {
    const iso = "2026-05-23T14:00:00Z"; // +2d
    expect(formatEligibleAtRelative(iso, NOW)).toBe("Fires in 2d");
  });

  it("formats past as 'Overdue Xh'", () => {
    const iso = "2026-05-21T12:00:00Z"; // -2h
    expect(formatEligibleAtRelative(iso, NOW)).toBe("Overdue 2h");
  });

  it("handles sub-minute as 'Fires now' / 'Overdue'", () => {
    expect(formatEligibleAtRelative("2026-05-21T14:00:30Z", NOW)).toBe("Fires now");
    expect(formatEligibleAtRelative("2026-05-21T13:59:30Z", NOW)).toBe("Overdue");
  });
});

describe("formatEligibleAt (combined)", () => {
  it("returns absolute + relative joined", () => {
    const iso = "2026-05-21T17:00:00Z"; // +3h
    const out = formatEligibleAt(iso, "America/New_York", NOW);
    expect(out).toMatch(/1:00.*\(Fires in 3h\)/);
  });
});

describe("formatDueAt", () => {
  // 2026-05-21T14:00:00Z is 10:00 AM in New York and 2:00 PM in London.
  const NOW_DUE = new Date("2026-05-21T14:00:00Z");

  it("renders the WORKSPACE clock, not the browser's", () => {
    const iso = "2026-05-21T21:30:00Z";
    expect(formatDueAt(iso, "America/New_York", NOW_DUE)).toBe("Today 5:30 PM");
    expect(formatDueAt(iso, "Europe/London", NOW_DUE)).toBe("Today 10:30 PM");
  });

  it("says Today / Tomorrow by the WORKSPACE calendar day", () => {
    // 01:30Z on the 22nd is still the 21st (9:30 PM) in New York, but already
    // "tomorrow" in London — the old browser-TZ version got one of these wrong
    // for every rep whose browser TZ != the workspace's.
    const iso = "2026-05-22T01:30:00Z";
    expect(formatDueAt(iso, "America/New_York", NOW_DUE)).toBe("Today 9:30 PM");
    expect(formatDueAt(iso, "Europe/London", NOW_DUE)).toBe("Tomorrow 2:30 AM");
  });

  it("falls back to a weekday + date further out", () => {
    const out = formatDueAt("2026-07-06T13:00:00Z", "America/New_York", NOW_DUE);
    expect(out).toContain("Mon");
    expect(out).toContain("Jul 6");
  });

  it("crosses a month boundary without claiming Tomorrow", () => {
    // 31 May → 1 Jun exercises nextDayKey's calendar rollover.
    const now = new Date("2026-05-31T12:00:00Z");
    expect(formatDueAt("2026-06-01T12:00:00Z", "UTC", now)).toBe("Tomorrow 12:00 PM");
    expect(formatDueAt("2026-06-02T12:00:00Z", "UTC", now)).not.toContain("Tomorrow");
  });

  it("falls back to UTC on a missing or bogus timezone", () => {
    expect(formatDueAt("2026-05-21T21:30:00Z", null, NOW_DUE)).toBe("Today 9:30 PM");
    expect(formatDueAt("2026-05-21T21:30:00Z", "Not/A_Real_Zone", NOW_DUE)).toBe("Today 9:30 PM");
  });

  it("returns a dash for a missing or unparseable timestamp", () => {
    expect(formatDueAt(null, "UTC", NOW_DUE)).toBe("—");
    expect(formatDueAt("not-a-date", "UTC", NOW_DUE)).toBe("—");
  });
});
