import { describe, it, expect } from "vitest";
import { describeColdSendFloor } from "../coldSendFloor";

// "Send automatically" is a dead switch unless the workspace floor is met. These
// guard that the rep is told, in plain language, exactly what's still missing —
// a regression here would silently hide why automatic email isn't firing.
describe("describeColdSendFloor", () => {
  it("is ready with no reasons when all three are met", () => {
    const status = describeColdSendFloor({
      autoSendEnabled: true,
      hasPostalAddress: true,
      hasTimezone: true,
    });
    expect(status.ready).toBe(true);
    expect(status.reasons).toEqual([]);
  });

  it("flags the workspace auto-send switch when it's off", () => {
    const status = describeColdSendFloor({
      autoSendEnabled: false,
      hasPostalAddress: true,
      hasTimezone: true,
    });
    expect(status.ready).toBe(false);
    expect(status.reasons).toHaveLength(1);
    expect(status.reasons[0]).toMatch(/automatic cold sending/i);
  });

  it("flags a missing postal address", () => {
    const status = describeColdSendFloor({
      autoSendEnabled: true,
      hasPostalAddress: false,
      hasTimezone: true,
    });
    expect(status.ready).toBe(false);
    expect(status.reasons[0]).toMatch(/mailing address/i);
  });

  it("flags a missing timezone", () => {
    const status = describeColdSendFloor({
      autoSendEnabled: true,
      hasPostalAddress: true,
      hasTimezone: false,
    });
    expect(status.ready).toBe(false);
    expect(status.reasons[0]).toMatch(/time zone/i);
  });

  it("lists every missing piece when nothing is set", () => {
    const status = describeColdSendFloor({
      autoSendEnabled: false,
      hasPostalAddress: false,
      hasTimezone: false,
    });
    expect(status.ready).toBe(false);
    expect(status.reasons).toHaveLength(3);
    // Every reason is a complete, actionable sentence pointing at Settings.
    for (const r of status.reasons) {
      expect(r).toMatch(/Settings/);
      expect(r.endsWith(".")).toBe(true);
    }
  });
});
