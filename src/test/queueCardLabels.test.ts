// ============================================================
// Unit Q2 — the Queue card says what actually happened.
//
// ALL BEHAVIOURAL. Every check drives the real exported functions
// (`describeQueueSituation` from src/lib/queueQueries, `buildWhyNowLine`
// from the card) with a table of inputs and asserts on the returned
// strings — no source-text greps, no call counting.
//
// The two things a rep has to be able to tell apart, and could not
// before this unit:
//   • "Follow up" meant a dozen different situations, all rendered
//     identically — including `rate_limited`, where NOTHING WAS SENT.
//   • the body under a follow-up card quoted the CUSTOMER's last
//     message, not the rep's unanswered one.
// ============================================================
import { describe, expect, it } from "vitest";

import { describeQueueSituation, type QueueLeadRow } from "@/lib/queueQueries";
import { buildWhyNowLine } from "@/components/queue/QueueCard";
import { QUEUE_ACTION_KEYS } from "@shared/followupRule";

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

function lead(over: Partial<QueueLeadRow> = {}): QueueLeadRow {
  return {
    id: "lead-1",
    name: "Dana Okafor",
    company: "Acme",
    email: "dana@acme.test",
    needs_action: true,
    next_action_key: null,
    next_action_label: null,
    action_reason_code: null,
    last_inbound_at: hoursAgo(2),
    last_outbound_at: daysAgo(6),
    action_dismissed_at: null,
    action_permanently_dismissed: false,
    action_resurfaced_at: null,
    motion: null,
    stage: null,
    whatsapp_number: null,
    phone: null,
    wa_opted_in: null,
    sms_opted_in: null,
    country: null,
    campaign_id: null,
    ...over,
  };
}

// situation key → [expected label, whose message the body shows]
const TABLE: [string, string, "inbound" | "outbound"][] = [
  ["reply_now", "They replied", "inbound"],
  ["ooo_return_followup", "They were away — they're back now", "outbound"],
  ["followup_due", "No reply to your last email", "outbound"],
  ["rate_limited", "Not sent — you're over your sending limit", "outbound"],
  ["closing_followup", "Your proposal needs chasing", "outbound"],
  ["generate_post_meeting_recap", "Send them the recap from your meeting", "outbound"],
  ["post_meeting_followup", "No word since your meeting", "outbound"],
  ["send_pre_2", "Intro sequence — second email is due", "outbound"],
  ["send_pre_3", "Intro sequence — third email is due", "outbound"],
  ["send_pre_4", "Intro sequence — fourth email is due", "outbound"],
  ["send_nurture_1", "Nurture sequence — email 1 is due", "outbound"],
  ["send_nurture_5", "Nurture sequence — email 5 is due", "outbound"],
  ["reengage", "Gone quiet — worth re-opening", "outbound"],
  ["switch_to_nurture", "Moving them to the slower nurture track", "outbound"],
];

describe("describeQueueSituation — one label per situation, in plain English", () => {
  it.each(TABLE)("%s reads as %s and shows the %s message", (key, label, bodySource) => {
    const s = describeQueueSituation({ next_action_key: key, next_action_label: null });
    expect(s.label).toBe(label);
    expect(s.bodySource).toBe(bodySource);
  });

  it("gives every distinct follow-up key a DISTINCT label", () => {
    // The bug: all of these rendered the identical word "Follow up".
    const followupKeys = TABLE.filter(([k]) => k !== "reply_now").map(([k]) => k);
    const labels = followupKeys.map(
      (k) => describeQueueSituation({ next_action_key: k, next_action_label: null }).label,
    );
    expect(new Set(labels).size).toBe(followupKeys.length);
  });

  it("never leaks a raw enum name or the bare word 'Follow up' as a whole label", () => {
    for (const [key] of TABLE) {
      const { label } = describeQueueSituation({ next_action_key: key, next_action_label: null });
      expect(label).not.toMatch(/_/); // send_pre_2, followup_due, …
      expect(label).not.toBe("Follow up");
    }
  });

  it("covers every action key the sync engine can write", () => {
    // QUEUE_ACTION_KEYS is pinned against syncEngine's literals by
    // src/test/followupRule.test.ts, so a new key upstream lands here.
    for (const key of QUEUE_ACTION_KEYS) {
      const { label } = describeQueueSituation({ next_action_key: key, next_action_label: null });
      expect(label, `no label for ${key}`).not.toBe("Needs a look");
    }
  });

  it("falls back to the server's own label, never to a raw key", () => {
    const s = describeQueueSituation({
      next_action_key: "some_future_key",
      next_action_label: "Chase the security review",
    });
    expect(s.label).toBe("Chase the security review");
    const bare = describeQueueSituation({ next_action_key: "some_future_key", next_action_label: null });
    expect(bare.label).toBe("Needs a look");
  });

  it("carries the rate-limit release date through as the detail clause", () => {
    const s = describeQueueSituation({
      next_action_key: "rate_limited",
      next_action_label: "Follow up anytime — auto-send paused until Sep 12",
    });
    expect(s.detail).toBe("auto-send paused until Sep 12");
    // And it does NOT pass the generic head of that label off as the headline.
    expect(s.label).not.toContain("Follow up anytime");
  });
});

describe("buildWhyNowLine — the line the rep reads", () => {
  const line = (key: string, over: Partial<QueueLeadRow> = {}, inbound?: { intent: string | null }) =>
    buildWhyNowLine(
      lead({ next_action_key: key, ...over }),
      describeQueueSituation({
        next_action_key: key,
        next_action_label: over.next_action_label ?? null,
      }),
      inbound ? ({ intent: inbound.intent } as never) : undefined,
    );

  it("a rate-limited card says nothing was sent, and when it can be", () => {
    const s = line("rate_limited", {
      next_action_label: "Follow up anytime — auto-send paused until Sep 12",
    });
    expect(s).toContain("Not sent");
    expect(s).toContain("auto-send paused until Sep 12");
    expect(s.startsWith("Follow up")).toBe(false);
  });

  it("times a follow-up off the rep's own last message", () => {
    const s = line("followup_due", { last_outbound_at: daysAgo(6), last_inbound_at: daysAgo(40) });
    expect(s).toContain("sent 6 days ago");
    expect(s).not.toContain("40");
  });

  it("times a reply off the customer's message, not the rep's", () => {
    const s = line("reply_now", { last_inbound_at: hoursAgo(2), last_outbound_at: daysAgo(30) });
    expect(s).toContain("2 hours ago");
    expect(s).not.toContain("sent ");
  });

  it("annotates the intent of THEIR message, and only on a card about their message", () => {
    expect(line("reply_now", {}, { intent: "pricing" })).toContain("pricing question");
    // A follow-up card is about the rep's email; an old inbound intent there
    // would be describing a different message than the one on screen.
    expect(line("followup_due", {}, { intent: "pricing" })).not.toContain("pricing question");
  });

  it("does not date a back-from-away card off a message that predates the absence", () => {
    const s = line("ooo_return_followup", { last_outbound_at: daysAgo(21) });
    expect(s).toBe("They were away — they're back now");
  });
});
