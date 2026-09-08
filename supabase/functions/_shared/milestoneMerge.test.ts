// Run: deno test supabase/functions/_shared/milestoneMerge.test.ts
//
// Deno mirror of src/lib/__tests__/leadDataFixes.test.ts (milestoneMergeByText).
// Text-keyed dedupe; "completed" beats "pending" on collision.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { mergeMilestonesByText, higherMilestoneStatus, removeMilestoneByText } from "./milestoneMerge.ts";

Deno.test("mergeMilestonesByText dedupes by text and escalates status", () => {
  const out = mergeMilestonesByText(
    [{ description: "Send proposal", status: "pending", date: null }],
    [
      { description: " send PROPOSAL ", status: "completed", date: "2026-09-02" },
      { description: "Security review", status: "pending", date: null },
    ],
  );
  assertEquals(out.map((m) => m.description), ["Send proposal", "Security review"]);
  assertEquals(out[0].status, "completed");
  assertEquals(out[0].date, "2026-09-02");
});

Deno.test("completed is never downgraded by a later pending", () => {
  const out = mergeMilestonesByText(
    [{ description: "Demo", status: "completed", date: "2026-09-01" }],
    [{ description: "demo", status: "pending", date: null }],
  );
  assertEquals(out[0].status, "completed");
  assertEquals(higherMilestoneStatus("pending", undefined), "pending");
});

Deno.test("removeMilestoneByText is text-keyed", () => {
  const out = removeMilestoneByText(
    [{ description: "A", status: "pending", date: null }, { description: "B", status: "pending", date: null }],
    " b ",
  );
  assertEquals(out.map((m) => m.description), ["A"]);
});
