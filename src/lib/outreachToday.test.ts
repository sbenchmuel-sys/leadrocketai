import { describe, expect, it } from "vitest";
import { groupByChannel } from "./outreachToday";
import type { OutreachTouch } from "./outreachQueue";

const touch = (id: string, channel: OutreachTouch["channel"], eligibleAt: string): OutreachTouch => ({
  id, campaignId: "c", campaignName: "C", leadId: `l-${id}`, leadName: "L", company: null,
  channel, stepNumber: 1, eligibleAt, email: null, phone: null, linkedinUrl: null, whatsappNumber: null,
  linkedinConnectedAt: null, subject: null, body: null, smsText: null, talkingPoints: null, voicemailScript: null,
});

describe("groupByChannel — the Today view's grouping", () => {
  it("groups in fixed channel order and keeps oldest-due first inside each group", () => {
    const page = [
      touch("a", "linkedin", "2026-09-01T08:00:00Z"),
      touch("b", "voice", "2026-09-01T09:00:00Z"),
      touch("c", "email", "2026-09-01T10:00:00Z"),
      touch("d", "voice", "2026-09-02T09:00:00Z"),
    ];
    const groups = groupByChannel(page);
    expect(groups.map((g) => g.channel)).toEqual(["email", "voice", "linkedin"]);
    expect(groups[1].touches.map((t) => t.id)).toEqual(["b", "d"]);
  });

  it("omits channels with nothing due", () => {
    expect(groupByChannel([touch("a", "sms", "2026-09-01T08:00:00Z")]).map((g) => g.channel)).toEqual(["sms"]);
    expect(groupByChannel([])).toEqual([]);
  });
});
