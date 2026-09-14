// ============================================================
// Unit Q2 — the card quotes the message it is actually about.
//
// BEHAVIOURAL: renders the real QueueCard and reads what is on screen.
// The pure label table is covered in queueCardLabels.test.ts; this file
// exists because the table being right is worth nothing if the card
// still passes the customer's inbound row to the body.
// ============================================================
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { QueueLeadRow, QueueLatestMessage } from "@/lib/queueQueries";

// Chainable fake PostgREST: awaiting any chain resolves `timelineRows`, and the
// chain itself is recorded so a test can assert what was asked for.
let timelineRows: unknown[] = [];
let lastChain: { fn: string; args: unknown[] }[] = [];
function builder(chain: { fn: string; args: unknown[] }[]): unknown {
  const target = () => undefined;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        lastChain = chain;
        return (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: timelineRows, error: null }).then(ok);
      }
      return (...args: unknown[]) => builder([...chain, { fn: String(prop), args }]);
    },
  });
}
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => builder([]), auth: { getUser: async () => ({ data: { user: null } }) } },
}));

const { QueueCard } = await import("@/components/queue/QueueCard");
const { fetchLatestOutbounds, isOutboundCall } = await import("@/lib/queueQueries");

const THEIRS = "Sounds good, what does pricing look like for 40 seats?";
const MINE = "Following up on the proposal I sent over last week.";

function msg(snippet: string, event_type: string): QueueLatestMessage {
  return {
    lead_id: "lead-1",
    occurred_at: new Date().toISOString(),
    ai_summary: null,
    snippet_text: snippet,
    subject: "Seats",
    intent: null,
    event_type,
    reply_worthy: null,
    urgency: null,
    tone: null,
    questions_extracted: [],
    language: null,
    sender_is_lead: null,
  };
}

function lead(next_action_key: string): QueueLeadRow {
  return {
    id: "lead-1", name: "Dana Okafor", company: "Acme", email: "dana@acme.test",
    needs_action: true, next_action_key, next_action_label: null, action_reason_code: null,
    last_inbound_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
    last_outbound_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    action_dismissed_at: null, action_permanently_dismissed: false, action_resurfaced_at: null,
    motion: null, stage: null, whatsapp_number: null, phone: null,
    wa_opted_in: null, sms_opted_in: null, country: null, campaign_id: null,
  };
}

const renderCard = (key: string, outbound: QueueLatestMessage = msg(MINE, "email_outbound")) =>
  render(
    <MemoryRouter>
      <QueueCard
        lead={lead(key)}
        latestInbound={msg(THEIRS, "email_inbound") as never}
        latestOutbound={outbound}
        onMarkHandled={() => {}}
        onSnooze={() => {}}
      />
    </MemoryRouter>,
  );

describe("QueueCard body", () => {
  it("a follow-up card shows the rep's own unanswered message", () => {
    renderCard("followup_due");
    expect(screen.getByText(new RegExp(MINE.slice(0, 30)))).toBeTruthy();
    expect(screen.queryByText(new RegExp(THEIRS.slice(0, 30)))).toBeNull();
    expect(screen.getByText("Your message")).toBeTruthy();
    expect(screen.getByText(/No reply to your last message/)).toBeTruthy();
  });

  it("does not offer 'Show full email' on a card about the rep's own message", () => {
    // Outbound interactions.body_text purges unconditionally at 72h and a
    // follow-up card is by definition older than that, so the button could only
    // ever toast "no longer stored".
    renderCard("followup_due");
    expect(screen.queryByRole("button", { name: /Show full email|Show the email you sent/ })).toBeNull();
  });

  it("a reply card shows the customer's message, and keeps Show full email", () => {
    renderCard("reply_now");
    expect(screen.getByText(new RegExp(THEIRS.slice(0, 30)))).toBeTruthy();
    expect(screen.queryByText(new RegExp(MINE.slice(0, 30)))).toBeNull();
    expect(screen.getByText("Their message")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show full email/ })).toBeTruthy();
  });

  it("a rate-limited card does not tell the rep to 'Follow up' as though it sent", () => {
    renderCard("rate_limited");
    expect(screen.getByText(/nothing was sent/)).toBeTruthy();
    // The action button may well still say "Follow up" — the rep CAN write to
    // this lead. What must not happen is the why-now line claiming a send.
    expect(screen.getByText(/nothing was sent/).textContent).toMatch(/this lead/);
  });

  it("keeps Mark as handled, Snooze and the lead link reachable on the card", () => {
    renderCard("followup_due");
    expect(screen.getByRole("button", { name: /Mark as handled/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Snooze/ })).toBeTruthy();
    expect(screen.getAllByRole("link").some((a) => a.getAttribute("href") === "/app/leads/lead-1")).toBe(true);
  });
});

describe("a follow-up triggered by a phone call", () => {
  const call = (): QueueLatestMessage => ({
    ...msg("Phone call (outbound) — 3 min", "call_completed"),
    duration_sec: 154,
  });

  it("renders the call, not an unrelated older email", () => {
    renderCard("followup_due", call());
    expect(screen.getByText("Your call")).toBeTruthy();
    expect(screen.getByText(/You called them — 3 min/)).toBeTruthy();
    // The bug: the card reached past the call for the next-newest written
    // message and captioned it "Your message".
    expect(screen.queryByText("Your message")).toBeNull();
    expect(screen.queryByText(new RegExp(MINE.slice(0, 30)))).toBeNull();
    expect(screen.getByText(/Nothing back since your call/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show full email/ })).toBeNull();
  });

  it("says it called without inventing a duration when the webhook sent none", () => {
    renderCard("followup_due", { ...call(), duration_sec: null });
    expect(screen.getByText("You called them")).toBeTruthy();
  });
});

describe("fetchLatestOutbounds", () => {
  it("asks the ledger for completed calls alongside the three written channels", async () => {
    timelineRows = [];
    await fetchLatestOutbounds(["lead-1"]);
    const types = lastChain.find((c) => c.fn === "in" && c.args[0] === "event_type")?.args[1] as string[];
    expect(types).toEqual(
      expect.arrayContaining(["email_outbound", "sms_outbound", "whatsapp_outbound", "call_completed"]),
    );
  });

  it("ignores an INBOUND call — that is not 'your last outbound'", async () => {
    timelineRows = [
      { lead_id: "lead-1", occurred_at: "2026-09-10T10:00:00Z", event_type: "call_completed",
        direction: "inbound", snippet_text: "they rang us", subject: null, metadata_json: { duration_sec: 60 }, intent: null },
      { lead_id: "lead-1", occurred_at: "2026-09-01T10:00:00Z", event_type: "email_outbound",
        direction: "outbound", snippet_text: MINE, subject: "Proposal", metadata_json: {}, intent: null },
    ];
    const map = await fetchLatestOutbounds(["lead-1"]);
    const row = map.get("lead-1")!;
    expect(row.event_type).toBe("email_outbound");
    expect(isOutboundCall(row)).toBe(false);
  });

  it("keeps an OUTBOUND call, with its duration", async () => {
    timelineRows = [
      { lead_id: "lead-1", occurred_at: "2026-09-10T10:00:00Z", event_type: "call_completed",
        direction: "outbound", snippet_text: "Phone call (outbound) — 3 min", subject: null,
        metadata_json: { duration_sec: 154 }, intent: null },
    ];
    const row = (await fetchLatestOutbounds(["lead-1"])).get("lead-1")!;
    expect(isOutboundCall(row)).toBe(true);
    expect(row.duration_sec).toBe(154);
  });
});
