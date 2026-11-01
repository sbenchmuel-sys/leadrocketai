// Lead Scout setup, step 1: chips ↔ profile_json. Every chip maps back to
// exactly one profile value, removing a chip removes only that value, and the
// sentence rewrites itself from what's left.
import { describe, expect, it } from "vitest";
import { clampProfile, profileSegments, profileSentence, removeChip, type Chip } from "@shared/scoutProfile";

const A1 = "11111111-1111-4111-8111-111111111111";
const profile = clampProfile(
  {
    titles: ["VP Sales", "Head of Revenue"],
    seniorities: ["vp"],
    industries: ["fintech"],
    employee_ranges: ["51,200", "10001,"],
    locations: ["United States"],
    keywords: ["payments"],
    exclusions: ["banks"],
    anchor_lead_ids: [A1],
  },
  [A1],
);
const chips = (p = profile) => profileSegments(p, { [A1]: "Acme Pay" }).filter((s): s is Chip => typeof s !== "string");

describe("scout profile chips", () => {
  it("one chip per profile value, with plain labels", () => {
    const all = chips();
    const values = Object.values(profile).reduce((n, l) => n + l.length, 0);
    expect(all).toHaveLength(values);
    expect(all.map((c) => c.label)).toEqual([
      "VP Sales", "Head of Revenue", "VPs", "fintech", "51–200 employees", "10,001+ employees",
      "United States", "payments", "Acme Pay", "banks",
    ]);
    for (const c of all) expect(profile[c.field]).toContain(c.value);
  });

  it("removing a chip removes only that value and rewrites the sentence", () => {
    const range = chips().find((c) => c.value === "10001,")!;
    const next = removeChip(profile, range);
    expect(next.employee_ranges).toEqual(["51,200"]);
    expect(next.titles).toEqual(profile.titles);
    expect(profileSentence(next)).not.toContain("10,001+");
  });

  it("removing every chip leaves a valid empty sentence", () => {
    const empty = chips().reduce((p, c) => removeChip(p, c), profile);
    expect(chips(empty)).toEqual([]);
    expect(profileSentence(empty)).toBe("I'll look for people.");
  });

  it("an anchor without a known name still renders", () => {
    expect(profileSentence(clampProfile({ anchor_lead_ids: [A1] }, [A1]))).toBe(
      "I'll look for people, similar to one of your leads.",
    );
  });
});
