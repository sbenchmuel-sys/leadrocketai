// Static guard for the cold auto-send gate column (BUG-012).
//
// Four places decide whether an email touch belongs to automation-executor or
// should surface as a review card: the scheduler, the executor, and the two
// inline "promote the next due touch" paths (enrollment + advanceColdEnrollment).
// All four MUST read the same workspace_automation_settings column,
// `cold_auto_send_enabled`. A misspelled column (the original bug read
// `auto_send_enabled`, which doesn't exist) fails the select silently, reads as
// "off", and parks every automatic first/next email as a manual review card
// that the executor then never sends.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const GATE_FILES = [
  "src/lib/campaignEnrollment.ts",
  "supabase/functions/_shared/coldOutreach.ts",
  "supabase/functions/campaign-touch-scheduler/index.ts",
  "supabase/functions/automation-executor/index.ts",
];

describe("cold auto-send gate column", () => {
  for (const rel of GATE_FILES) {
    it(`${rel} reads cold_auto_send_enabled and never a bare auto_send_enabled`, () => {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src.includes("cold_auto_send_enabled")).toBe(true);
      // A bare `auto_send_enabled` (not preceded by `cold_`) is the bug.
      expect(/(?<!cold_)auto_send_enabled/.test(src)).toBe(false);
    });
  }
});
