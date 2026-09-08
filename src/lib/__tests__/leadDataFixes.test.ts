// Unit L1 — Lead page data fixes.
//
// Four guards from the lead page audit:
//   1. getLeadDetailSelect  — the lead detail select must carry ooo_until and
//      group_id (OOO badge, "Out of office until" status line, group timeline).
//   2. queueRecomputeEnqueues — no direct fetch of recompute-lead-intelligence
//      remains in timelineProjector / sms-webhook; the projector goes through
//      the enqueue RPC so N signals per drain window cost one recompute.
//   3. milestoneMergeByText — pure merge: text-keyed dedupe, completed beats pending.
//   4. risksNotReseeded — recompute-lead-intelligence no longer copies
//      leads.risks_json back into its output (which made every risk immortal).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LEAD_DETAIL_SELECT } from "@/lib/supabaseQueries";
import {
  mergeMilestonesByText,
  higherMilestoneStatus,
  removeMilestoneByText,
  setMilestoneStatusByText,
} from "../../../supabase/functions/_shared/milestoneMerge.ts";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("getLeadDetailSelect", () => {
  const cols = LEAD_DETAIL_SELECT.split(",").map((c) => c.trim());
  it("selects ooo_until (OOO badge + status line)", () => {
    expect(cols).toContain("ooo_until");
  });
  it("selects group_id (group timeline)", () => {
    expect(cols).toContain("group_id");
  });
  it("getLeadDetail actually uses the exported select", () => {
    expect(read("src/lib/supabaseQueries.ts")).toMatch(/\.select\(LEAD_DETAIL_SELECT\)/);
  });
});

describe("queueRecomputeEnqueues", () => {
  it("timelineProjector enqueues via the RPC and never fetches the recompute function", () => {
    const src = read("supabase/functions/_shared/timelineProjector.ts");
    expect(src).toContain('rpc("enqueue_lead_intelligence_recompute"');
    expect(src).not.toMatch(/functions\/v1\/recompute-lead-intelligence/);
  });
  it("sms-webhook has no direct recompute call and triggers via the projector once", () => {
    const src = read("supabase/functions/sms-webhook/index.ts");
    expect(src).not.toMatch(/functions\/v1\/recompute-lead-intelligence/);
    expect((src.match(/triggerRecompute: true/g) ?? []).length).toBe(1);
  });
  it("the drain still owns the only worker-side recompute call", () => {
    expect(read("supabase/functions/intelligence-queue-drain/index.ts")).toMatch(/functions\/v1\/recompute-lead-intelligence/);
  });
});

describe("milestoneMergeByText", () => {
  it("dedupes by description text, case/whitespace-insensitive, preserving order", () => {
    const out = mergeMilestonesByText(
      [{ description: "Send proposal", status: "pending", date: null }],
      [
        { description: "  send PROPOSAL ", status: "pending", date: null },
        { description: "Security review", status: "pending", date: null },
      ],
    );
    expect(out.map((m) => m.description)).toEqual(["Send proposal", "Security review"]);
  });

  it("completed beats pending regardless of which side says it", () => {
    const a = mergeMilestonesByText(
      [{ description: "Demo", status: "completed", date: "2026-09-01" }],
      [{ description: "demo", status: "pending", date: null }],
    );
    expect(a[0].status).toBe("completed");
    expect(a[0].date).toBe("2026-09-01");

    const b = mergeMilestonesByText(
      [{ description: "Demo", status: "pending", date: null }],
      [{ description: "demo", status: "completed", date: "2026-09-02", completedAt: "2026-09-02T10:00:00Z" }],
    );
    expect(b[0].status).toBe("completed");
    expect(b[0].date).toBe("2026-09-02");
    expect(b[0].completedAt).toBe("2026-09-02T10:00:00Z");
  });

  it("collapses duplicates inside a single list and skips blank descriptions", () => {
    const out = mergeMilestonesByText(
      [
        { description: "Pricing sent", status: "pending", date: null },
        { description: "pricing sent", status: "completed", date: null },
        { description: "   ", status: "pending", date: null },
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("completed");
  });

  it("higherMilestoneStatus treats unknown as pending", () => {
    expect(higherMilestoneStatus(undefined, null)).toBe("pending");
    expect(higherMilestoneStatus("weird", "completed")).toBe("completed");
  });

  it("remove and set-status are keyed by text, not index", () => {
    const list = [
      { description: "A", status: "pending", date: null },
      { description: "B", status: "pending", date: null },
    ];
    expect(removeMilestoneByText(list, " b ").map((m) => m.description)).toEqual(["A"]);
    const toggled = setMilestoneStatusByText(list, "a", true, "2026-09-08T12:00:00.000Z");
    expect(toggled[0]).toMatchObject({ status: "completed", date: "2026-09-08", completedAt: "2026-09-08T12:00:00.000Z" });
    expect(toggled[1].status).toBe("pending");
  });
});

describe("recompute seeds from the MERGE of canonical and mirror", () => {
  it("keeps a milestone that only reached the leads mirror and the higher status from either side", () => {
    const canonical = [
      { description: "Demo", status: "pending", date: null },
      { description: "Security review", status: "completed", date: "2026-09-01" },
    ];
    const mirror = [
      { description: "demo", status: "completed", date: "2026-09-03" }, // non-owner tick, mirror only
      { description: "Security review", status: "pending", date: null },
      { description: "Uploaded-only milestone", status: "pending", date: null },
    ];
    const seed = mergeMilestonesByText(canonical, mirror);
    expect(seed.map((m) => m.description)).toEqual(["Demo", "Security review", "Uploaded-only milestone"]);
    expect(seed[0].status).toBe("completed");
    expect(seed[1].status).toBe("completed");
  });
  it("recompute-lead-intelligence merges both lists rather than picking the first non-empty", () => {
    const src = read("supabase/functions/recompute-lead-intelligence/index.ts");
    expect(src).toMatch(/const leadMilestones = mergeMilestonesByText\(/);
    expect(src).not.toMatch(/Array\.isArray\(priorIntelMilestones\)\s*\?\s*\(priorIntelMilestones as any\[\]\)\s*:\s*Array\.isArray\(lead\.milestones_json\)/);
  });
  it("MeetingsTab ticks lead milestones by text, not pack row index", () => {
    const src = read("src/components/lead/MeetingsTab.tsx");
    expect(src).not.toMatch(/updateLeadMilestoneStatus\(leadId, i,/);
    expect((src.match(/updateLeadMilestoneStatus\(leadId, m\.description,/g) ?? []).length).toBe(2);
  });
});

describe("risksNotReseeded", () => {
  const src = read("supabase/functions/recompute-lead-intelligence/index.ts");
  it("does not seed risksMap from leads.risks_json", () => {
    expect(src).not.toMatch(/const leadRisks\s*=/);
    expect(src).not.toMatch(/addRisk\([^)]*"lead_analysis"\)/);
  });
  it("keeps milestone seeding and escalates status on match", () => {
    expect(src).toMatch(/addMilestone\([^)]*"lead_analysis"\)/);
    expect(src).toContain("higherMilestoneStatus(existing.status, status)");
  });
});

describe("deep analysis save keeps canonical and mirror in sync", () => {
  it("saveLeadDeepAnalysis writes next step to canonical unconditionally (null included)", () => {
    const src = read("src/lib/supabaseQueries.ts");
    const fn = src.slice(src.indexOf("export async function saveLeadDeepAnalysis"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    expect(body).not.toMatch(/input\.nextStep\s*\?\s*\{/);
    expect((body.match(/recommended_next_step: input\.nextStep/g) ?? []).length).toBe(1);
    expect((body.match(/\bnext_step: input\.nextStep/g) ?? []).length).toBe(1);
  });
  it("UploadTab skips the save entirely when the analysis failed or could not be parsed", () => {
    const src = read("src/components/lead/UploadTab.tsx");
    const skip = src.indexOf("if (!analysisOk)");
    const save = src.indexOf("await saveLeadDeepAnalysis(");
    expect(skip).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(skip);
    expect(src.slice(skip, save)).toMatch(/return;/);
  });
});
