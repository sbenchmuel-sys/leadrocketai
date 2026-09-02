// TEMP verification — re-engagement trigger end-to-end (logic level).
// Confirms a previously-warm lead that has gone quiet after our last
// outbound is routed to the `re_engagement_intro` draft task.
import { describe, it, expect } from "vitest";
import { playbookResolver } from "./playbookResolver";
import type { ResolvedContext } from "./contextResolver";

function quietPostEngagementLead(): ResolvedContext {
  // Inbound-sourced lead (came in warm via contact form), one prior thread,
  // and OUR outbound is the most recent thing — they went quiet.
  return {
    motion: "inbound_response",
    source_type: "contact_form",
    meeting_packs: [],
    has_unsent_recap: false,
    nurture_outbound_count: 0,
    thread_emails: [
      { direction: "inbound", occurred_at: "2026-06-01T10:00:00Z" },
      { direction: "outbound", occurred_at: "2026-06-10T10:00:00Z" },
    ],
    last_inbound_email: { occurred_at: "2026-06-01T10:00:00Z", body_text: "Can you send pricing?" },
    last_outbound_email: { occurred_at: "2026-06-10T10:00:00Z", body_text: "Here is our deck." },
    lead: { next_action_key: null, milestones_json: [
      { status: "completed", description: "Discovery call held" },
      { status: "pending", description: "Send security questionnaire" },
    ] },
  } as unknown as ResolvedContext;
}

describe("re-engagement routing", () => {
  it("routes a quiet, previously-warm lead to re_engagement_intro", () => {
    const rec = playbookResolver(quietPostEngagementLead(), "email");
    expect(rec.recommended_intent).toBe("re_engagement_intro");
    expect(rec.recommended_playbook).toBe("Re-engagement");
  });

  it("does NOT re-engage when the prospect's reply is the newest message", () => {
    const ctx = quietPostEngagementLead();
    (ctx as any).last_inbound_email.occurred_at = "2026-06-20T10:00:00Z"; // newer than outbound
    const rec = playbookResolver(ctx, "email");
    expect(rec.recommended_intent).toBe("reply_to_thread");
  });

  it("does NOT re-engage a cold outbound-only lead (it starts the sequence instead)", () => {
    const ctx = quietPostEngagementLead();
    (ctx as any).motion = "outbound_prospecting";
    (ctx as any).source_type = "manual";
    const rec = playbookResolver(ctx, "email");
    expect(rec.recommended_intent).not.toBe("re_engagement_intro");
  });
});
