import { describe, expect, it } from "vitest";
import {
  formatEligibleAtAbsolute,
  formatEligibleAtRelative,
  formatEligibleAt,
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
