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
  ["followup_due", "No reply to your last message", "outbound"],
  [
    "rate_limited",
    "Too many emails to this lead recently — nothing was sent; you can still write to them",
    "outbound",
  ],
  ["closing_followup", "Your proposal needs chasing", "outbound"],
  ["generate_post_meeting_recap", "Send them the recap from your meeting", "outbound"],
  ["post_meeting_followup", "No word since your meeting", "outbound"],
  ["send_pre_2", "Intro sequence — second email is due", "outbound"],
  ["send_pre_3", "Intro sequence — third email is due", "outbound"],
  ["send_pre_4", "Breakup email is due — the last one before you let this go", "outbound"],
  ["send_nurture_1", "Nurture sequence — email 1 is due", "outbound"],
  ["send_nurture_5", "Nurture sequence — email 5 is due", "outbound"],
  ["reengage", "Gone quiet — worth re-opening", "outbound"],
  ["switch_to_nurture", "Three emails, no reply — switch them to the slow track?", "outbound"],
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

  it("describes a call-triggered follow-up as a call, not as a message", () => {
    // twilio-voice-webhook writes a voice_outbound interaction and calls
    // postSendDeriveAction, which recomputes leads.last_outbound_at — so
    // followup_due can be timed off a phone call.
    const call = describeQueueSituation(
      { next_action_key: "followup_due", next_action_label: null },
      { latestOutboundIsCall: true },
    );
    expect(call.label).toBe("Nothing back since your call");
    expect(call.bodySource).toBe("outbound");
    // Everything else is about a proposal or a meeting, not about the medium.
    const closing = describeQueueSituation(
      { next_action_key: "closing_followup", next_action_label: null },
      { latestOutboundIsCall: true },
    );
    expect(closing.label).toBe("Your proposal needs chasing");
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

  it("scopes the volume cap to THIS lead and to the automatic send", () => {
    // The cap is max_emails_per_lead_per_7d/_30d — per lead, not per account —
    // and followupRule.ts requires the label not to read as "you may not act".
    const { label } = describeQueueSituation({ next_action_key: "rate_limited", next_action_label: null });
    expect(label).toMatch(/this lead/i);
    expect(label).not.toMatch(/your sending limit|your daily limit|you're over your/i);
    expect(label).toMatch(/you can still write/i);
  });

  it("asks about the nurture switch rather than announcing it", () => {
    // `auto_nurture_eligible` is a read-only flag; nothing switches the motion,
    // so a status-shaped label would tell the rep to skip the one card that
    // needs their decision.
    const { label } = describeQueueSituation({ next_action_key: "switch_to_nurture", next_action_label: null });
    expect(label.endsWith("?")).toBe(true);
    expect(label).not.toMatch(/^Moving|^Switching|^Moved/);
  });

  it("says 'breakup' on the breakup email", () => {
    const { label } = describeQueueSituation({ next_action_key: "send_pre_4", next_action_label: null });
    expect(label).toMatch(/breakup/i);
  });

  it("says 'message', not 'email', on a cross-channel follow-up trigger", () => {
    // last_outbound_at is stamped by the SMS and WhatsApp senders too.
    const { label } = describeQueueSituation({ next_action_key: "followup_due", next_action_label: null });
    expect(label).toMatch(/message/);
    expect(label).not.toMatch(/email/i);
  });

  it("suppresses the timestamp where it would date the wrong thing", () => {
    // recap: there is no outbound AFTER the meeting, so last_outbound_at is a
    // pre-meeting email; rate_limited: "Not sent … sent 3 hours ago".
    for (const key of ["generate_post_meeting_recap", "rate_limited", "ooo_return_followup"]) {
      expect(
        describeQueueSituation({ next_action_key: key, next_action_label: null }).showTime,
        `${key} should not be dated`,
      ).toBe(false);
    }
    expect(describeQueueSituation({ next_action_key: "followup_due", next_action_label: null }).showTime).toBe(true);
  });
});

describe("buildWhyNowLine — the line the rep reads", () => {
  const line = (
    key: string,
    over: Partial<QueueLeadRow> = {},
    msg?: { intent?: string | null; event_type?: string },
  ) =>
    buildWhyNowLine(
      lead({ next_action_key: key, ...over }),
      describeQueueSituation(
        { next_action_key: key, next_action_label: over.next_action_label ?? null },
        { latestOutboundIsCall: msg?.event_type === "call_completed" },
      ),
      msg ? ({ intent: msg.intent ?? null, event_type: msg.event_type ?? "email_inbound" } as never) : undefined,
    );

  it("a rate-limited card says nothing was sent, and when auto-send resumes", () => {
    const s = line("rate_limited", {
      next_action_label: "Follow up anytime — auto-send paused until Sep 12",
      last_outbound_at: hoursAgo(3),
    });
    expect(s).toContain("nothing was sent");
    expect(s).toContain("auto-send paused until Sep 12");
    expect(s.startsWith("Follow up")).toBe(false);
    // The line must not contradict itself: "Not sent … sent 3 hours ago".
    expect(s).not.toMatch(/sent \d+ hour/);
  });

  it("says 'called', not 'sent', when the last outbound was a phone call", () => {
    const s = line("followup_due", { last_outbound_at: daysAgo(4) }, { event_type: "call_completed" });
    expect(s).toBe("Nothing back since your call · called 4 days ago");
    expect(s).not.toContain("sent");
  });

  it("does not date a recap card off a pre-meeting email", () => {
    const s = line("generate_post_meeting_recap", { last_outbound_at: daysAgo(8) });
    expect(s).toBe("Send them the recap from your meeting");
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
