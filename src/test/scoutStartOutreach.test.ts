// Lead Scout "Start outreach": only live review-mode cold outreach is offered,
// and the suggestion is the best performer (or the most used when samples are small).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ workspaceId: null }) }));

import { eligibleCadences, rankCadences, type CadenceStats } from "@/components/leads/scout/StartOutreach";

const c = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, status: "active", send_mode: "review", motion: "outbound_prospecting", ...o }) as never;

describe("eligibleCadences", () => {
  it("keeps only active, review-mode, outbound campaigns", () => {
    const out = eligibleCadences([
      c("ok"),
      c("auto", { send_mode: "automatic" }),
      c("draft", { status: "draft" }),
      c("paused", { status: "paused" }),
      c("nurture", { motion: "nurture" }),
      c("legacy", { send_mode: null }), // missing column default = review
    ]) as Array<{ id: string }>;
    expect(out.map((x) => x.id)).toEqual(["ok", "legacy"]);
  });
});

describe("rankCadences", () => {
  const stats = (o: Record<string, CadenceStats>) => new Map(Object.entries(o));
  it("best (replies + meetings) / enrolled wins among cadences with enough people", () => {
    const ranked = rankCadences([c("a"), c("b"), c("c")], stats({
      a: { enrolled: 100, replied: 5, meetings: 0 },
      b: { enrolled: 20, replied: 3, meetings: 1 },
      c: { enrolled: 5, replied: 5, meetings: 5 }, // too small to trust
    })) as Array<{ id: string }>;
    expect(ranked.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
  it("no reliable signal → most used, ties keep input order", () => {
    const ranked = rankCadences([c("new"), c("used"), c("none")], stats({
      used: { enrolled: 8, replied: 0, meetings: 0 },
    })) as Array<{ id: string }>;
    expect(ranked.map((x) => x.id)).toEqual(["used", "new", "none"]);
    expect(rankCadences([], new Map())).toEqual([]);
  });
});
