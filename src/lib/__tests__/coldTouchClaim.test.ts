import { describe, it, expect } from "vitest";
// Pure leaf — zero server-only imports, so it loads under vitest.
import {
  coldTouchClaimKey,
  coldTouchClaimAcquired,
} from "../../../supabase/functions/_shared/coldTouchClaim";

// The per-touch double-send guard. The DB unique index is the real concurrency
// guard (not unit-testable without a database); these pin the application side:
// a stable, per-touch-unique claim key, and "only send when the claim was won."
describe("coldTouchClaimKey", () => {
  it("is the stable cold_touch_<id> key", () => {
    expect(coldTouchClaimKey("abc-123")).toBe("cold_touch_abc-123");
  });

  it("is identical for the same touch (so the lifetime/per-day dedup finds it)", () => {
    expect(coldTouchClaimKey("t1")).toBe(coldTouchClaimKey("t1"));
  });

  it("is distinct for different touches (no cross-touch collision)", () => {
    expect(coldTouchClaimKey("t1")).not.toBe(coldTouchClaimKey("t2"));
  });
});

describe("coldTouchClaimAcquired — send only when the claim was won", () => {
  it("true only when no error AND a row came back", () => {
    expect(coldTouchClaimAcquired(null, { id: "log-1" })).toBe(true);
  });

  it("false on a duplicate-key (23505) race — the touch was already claimed", () => {
    expect(coldTouchClaimAcquired({ code: "23505", message: "duplicate" }, null)).toBe(false);
  });

  it("false on any other insert error", () => {
    expect(coldTouchClaimAcquired({ code: "08006", message: "conn" }, { id: "x" })).toBe(false);
  });

  it("false when no row returned even without an error", () => {
    expect(coldTouchClaimAcquired(null, null)).toBe(false);
    expect(coldTouchClaimAcquired(null, undefined)).toBe(false);
  });
});
