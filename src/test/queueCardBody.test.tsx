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

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), auth: { getUser: async () => ({ data: { user: null } }) } },
}));

const { QueueCard } = await import("@/components/queue/QueueCard");

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

const renderCard = (key: string) =>
  render(
    <MemoryRouter>
      <QueueCard
        lead={lead(key)}
        latestInbound={msg(THEIRS, "email_inbound") as never}
        latestOutbound={msg(MINE, "email_outbound")}
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
