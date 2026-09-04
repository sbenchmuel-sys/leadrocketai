// The People-list cadence state machine (Sprint 2 #13) and the auto-skip tally
// that feeds the campaign's "N steps auto-skipped" line (#9).
import { describe, expect, it } from "vitest";
import { deriveCadenceStatus, cadenceStatusLabel, type CadenceTouchRow } from "./campaignQueries";

const fmt = (iso: string | null) => (iso ? `AT(${iso})` : "—");

/** A 3-step cadence: email → call → linkedin. */
const plan = (statuses: string[]): CadenceTouchRow[] =>
  ["email", "voice", "linkedin"].map((channel, i) => ({
    step_number: i + 1,
    channel,
    status: statuses[i],
    eligible_at: `2026-05-2${i + 1}T09:00:00Z`,
  }));

describe("deriveCadenceStatus", () => {
  it("reports the NEXT step from the enrollment cursor, not the first unsent row", () => {
    // Step 1 sent, step 2 is live. Later rows are pre-created and must not win.
    const s = deriveCadenceStatus(
      { status: "active", current_step_number: 1 },
      plan(["sent", "queued", "scheduled"]),
    );
    expect(s.state).toBe("due");
    expect(s.stepNumber).toBe(2);
    expect(s.channel).toBe("voice");
    expect(s.totalSteps).toBe(3);
  });

  it("distinguishes a step that is merely scheduled from one on the Queue", () => {
    const s = deriveCadenceStatus(
      { status: "active", current_step_number: 1 },
      plan(["sent", "scheduled", "scheduled"]),
    );
    expect(s.state).toBe("waiting");
    expect(s.dueAt).toBe("2026-05-22T09:00:00Z");
  });

  it("treats a cursor past the last step as finished", () => {
    const s = deriveCadenceStatus({ status: "active", current_step_number: 3 }, plan(["sent", "sent", "sent"]));
    expect(s.state).toBe("completed");
    expect(s.stepNumber).toBeNull();
  });

  it("lets a terminal enrollment status win over any remaining touch rows", () => {
    for (const status of ["replied", "stopped", "completed"] as const) {
      const s = deriveCadenceStatus({ status, current_step_number: 1 }, plan(["sent", "queued", "scheduled"]));
      expect(s.state).toBe(status);
      expect(s.stepNumber).toBeNull();
    }
  });

  it("reads a lead with no enrollment row as not started", () => {
    expect(deriveCadenceStatus(null, []).state).toBe("not_started");
  });

  it("starts a fresh enrollment on step 1", () => {
    const s = deriveCadenceStatus({ status: "scheduled", current_step_number: 0 }, plan(["scheduled", "scheduled", "scheduled"]));
    expect(s.stepNumber).toBe(1);
    expect(s.state).toBe("waiting");
  });

  it("tolerates a null cursor as step 0", () => {
    expect(deriveCadenceStatus({ status: "active", current_step_number: null }, plan(["scheduled", "scheduled", "scheduled"])).stepNumber).toBe(1);
  });

  it("counts auto-skipped steps in every state — that is the whole point of surfacing them", () => {
    expect(deriveCadenceStatus({ status: "active", current_step_number: 2 }, plan(["sent", "auto_skipped", "queued"])).autoSkipped).toBe(1);
    expect(deriveCadenceStatus({ status: "replied", current_step_number: 2 }, plan(["auto_skipped", "auto_skipped", "scheduled"])).autoSkipped).toBe(2);
  });
});

describe("cadenceStatusLabel", () => {
  it("names the step, the channel and when it is due", () => {
    const s = deriveCadenceStatus({ status: "active", current_step_number: 1 }, plan(["sent", "scheduled", "scheduled"]));
    expect(cadenceStatusLabel(s, fmt)).toBe("Step 2 of 3 · Call · due AT(2026-05-22T09:00:00Z)");
  });

  it("says 'due now' for a step already on the Queue", () => {
    const s = deriveCadenceStatus({ status: "active", current_step_number: 1 }, plan(["sent", "queued", "scheduled"]));
    expect(cadenceStatusLabel(s, fmt)).toContain("due now");
  });

  it("has plain wording for every terminal state and for no status at all", () => {
    for (const status of ["replied", "stopped", "completed"] as const) {
      const label = cadenceStatusLabel(deriveCadenceStatus({ status, current_step_number: 1 }, plan(["sent", "queued", "scheduled"])), fmt);
      expect(label).not.toContain("Step");
      expect(label.length).toBeGreaterThan(0);
    }
    expect(cadenceStatusLabel(undefined, fmt)).toBe("Not in the cadence yet");
  });
});
