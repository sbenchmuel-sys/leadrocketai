// Unit L2 (Codex P1) — a slow-drip lead must not get the generic automation
// card as well as its own.
//
// The generic card's Pause / Disable clear needs_action, eligible_at and
// automation_mode WITHOUT touching nurture_status, so a rep could "pause" a
// slow drip there and still see NurturePreviewCard reporting it Active for a
// sequence the executor will never send. The header chip already excludes
// nurture leads; the sheet's "Automation details" section must use the same rule.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const leads: Record<string, Record<string, unknown>> = {
  drip: {
    id: "drip", name: "Nina Drip", email: "nina@acme.test", company: "Acme", phone: null,
    stage: "engaged", motion: "nurture", automation_mode: "hybrid", needs_action: true,
    eligible_at: new Date().toISOString(), next_action_key: "nurture_2",
    nurture_status: "active", last_outbound_at: new Date().toISOString(),
    last_inbound_at: null, has_future_meeting: false,
  },
  outbound: {
    id: "outbound", name: "Otto Bound", email: "otto@beta.test", company: "Beta", phone: null,
    stage: "engaged", motion: "outbound_prospecting", automation_mode: "hybrid", needs_action: true,
    eligible_at: new Date().toISOString(), next_action_key: "send_pre_2",
    last_outbound_at: new Date().toISOString(), last_inbound_at: null, has_future_meeting: false,
  },
};

vi.mock("@/lib/supabaseQueries", () => ({
  getLeadDetail: vi.fn(async (id: string) => leads[id] ?? null),
  getLeadIntelligence: vi.fn(async () => null),
  deleteLead: vi.fn(async () => {}),
  markActionHandled: vi.fn(async () => ({})),
  undoMarkActionHandled: vi.fn(async () => {}),
  triggerIntelligenceRecompute: vi.fn(async () => ({ ok: true })),
  getLeadMeetingPacks: vi.fn(async () => []),
}));
vi.mock("@/lib/leadActivity", () => ({ getLeadActivityFeed: vi.fn(async () => []) }));
vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, in: () => chain, update: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: unknown[]; count: number; error: null }) => void) =>
      resolve({ data: [], count: 0, error: null }),
  });
  return { supabase: { from: () => chain, auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/hooks/useGmailConnection", () => ({ useGmailConnection: () => ({ isConnected: true, connectGmail: vi.fn() }) }));
vi.mock("@/hooks/useVisibilityRefresh", () => ({ useVisibilityRefresh: () => {} }));
vi.mock("@/hooks/useMailSync", () => ({ useMailSync: () => ({ isConnected: false, isLoading: false }) }));
vi.mock("@/hooks/useBackgroundDraftQueue", () => ({
  useBackgroundDraftQueue: () => ({ enqueue: vi.fn(), getStatus: () => undefined, consume: vi.fn() }),
}));
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ workspaceId: "ws-1" }) }));

// The two cards under test render as markers; everything else is out of scope.
vi.mock("@/components/lead/AutomationPreviewCard", () => ({ default: () => <div>GENERIC AUTOMATION CARD</div> }));
vi.mock("@/components/lead/NurturePreviewCard", () => ({ default: () => <div>SLOW DRIP CARD</div> }));
vi.mock("@/components/lead/TimelineTab", () => ({ default: () => null }));
vi.mock("@/components/lead/DraftsTab", () => ({ default: () => null }));
vi.mock("@/components/lead/UploadTab", () => ({ default: () => null }));
vi.mock("@/components/lead/RecommendationsTab", () => ({ default: () => null }));
vi.mock("@/components/lead/MeetingsTab", () => ({ default: () => null }));
vi.mock("@/components/lead/LeadContextPanel", () => ({ default: () => null }));
vi.mock("@/components/lead/StakeholdersPartnersPanel", () => ({ default: () => null }));
vi.mock("@/components/lead/PostMeetingRecapHint", () => ({ default: () => null }));
vi.mock("@/components/lead/StakeholderAvatarRow", () => ({ default: () => null }));
vi.mock("@/components/lead/EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("@/components/leads/UnifiedIntelligenceCard", () => ({ UnifiedIntelligenceCard: () => null }));
vi.mock("@/components/dashboard/EmailActionDialog", () => ({ EmailActionDialog: () => null }));
vi.mock("@/components/call/ClickToCallButton", () => ({ ClickToCallButton: () => null }));
vi.mock("@/components/mail/MailReconnectChip", () => ({ MailReconnectChip: () => null }));
vi.mock("@/components/gmail/GmailSyncButton", () => ({ GmailSyncButton: () => null }));

import LeadDetailPage from "@/pages/LeadDetail";

async function openDealSheet(id: string) {
  render(
    <MemoryRouter initialEntries={[`/app/leads/${id}`]}>
      <Routes>
        <Route path="/app/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /more about this deal/i }));
  return screen.findByText("Automation details");
}

describe("sheetAutomationDetails", () => {
  it("a slow-drip lead gets ONLY its own card — never the generic one", async () => {
    await openDealSheet("drip");
    expect(screen.getByText("SLOW DRIP CARD")).toBeInTheDocument();
    expect(screen.queryByText("GENERIC AUTOMATION CARD")).toBeNull();
    // …and it isn't told to use an automation chip it doesn't have.
    expect(screen.queryByText(/automation chip at the top/i)).toBeNull();
  });

  it("an outbound lead still gets the generic automation controls", async () => {
    await openDealSheet("outbound");
    expect(screen.getByText("GENERIC AUTOMATION CARD")).toBeInTheDocument();
  });
});
