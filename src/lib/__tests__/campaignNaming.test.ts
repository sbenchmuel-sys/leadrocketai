import { describe, it, expect } from "vitest";
import { dedupeCampaignName } from "../campaignNaming";

// A starter clones in with a fixed name, so adding the same starter twice would
// otherwise produce two indistinguishable "Inbound Intro" outreaches. These
// guard the auto-suffix that keeps each one tellable-apart.
describe("dedupeCampaignName", () => {
  it("returns the name unchanged when nothing collides", () => {
    expect(dedupeCampaignName("Inbound Intro", [])).toBe("Inbound Intro");
    expect(dedupeCampaignName("Inbound Intro", ["Cold Outbound"])).toBe("Inbound Intro");
  });

  it("appends ' 2' on the first collision", () => {
    expect(dedupeCampaignName("Inbound Intro", ["Inbound Intro"])).toBe("Inbound Intro 2");
  });

  it("walks up to the first free suffix", () => {
    expect(
      dedupeCampaignName("Inbound Intro", ["Inbound Intro", "Inbound Intro 2"]),
    ).toBe("Inbound Intro 3");
  });

  it("fills a gap in the suffix sequence rather than always taking the max+1", () => {
    // 2 is free even though 3 is taken — use the smallest free suffix.
    expect(
      dedupeCampaignName("Inbound Intro", ["Inbound Intro", "Inbound Intro 3"]),
    ).toBe("Inbound Intro 2");
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(dedupeCampaignName("Inbound Intro", ["  inbound intro  "])).toBe("Inbound Intro 2");
  });

  it("trims the desired name before comparing and returning", () => {
    expect(dedupeCampaignName("  Inbound Intro  ", ["Inbound Intro"])).toBe("Inbound Intro 2");
  });

  it("tolerates null/empty entries in the existing list", () => {
    expect(
      dedupeCampaignName("Inbound Intro", ["", null as unknown as string, "Inbound Intro"]),
    ).toBe("Inbound Intro 2");
  });

  it("returns an empty string unchanged (no name to dedupe)", () => {
    expect(dedupeCampaignName("   ", ["anything"])).toBe("");
  });
});
