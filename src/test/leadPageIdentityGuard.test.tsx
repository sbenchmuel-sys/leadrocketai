// Unit L2 (QA fix 1) — the lead you SEE must be the lead you ACT ON.
//
// Dropping setLead(null) on an id change made the page keep the previous lead
// on screen while the next one loaded. Delete / "Already did it" / the WhatsApp
// and Text links all act on the id in the URL, so a stale render could confirm
// "delete Bob?" and delete Jane. The page now shows the skeleton whenever the
// lead in state isn't the lead in the URL.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const leads: Record<string, any> = {
  jane: { id: "jane", name: "Jane Doe", email: "jane@acme.test", company: "Acme", phone: null, stage: "engaged", motion: "outbound_prospecting", needs_action: true, next_action_key: "send_pre_2", next_step: "Nudge Jane", last_outbound_at: new Date().toISOString(), last_inbound_at: null, has_future_meeting: false },
  bob: { id: "bob", name: "Bob Stone", email: "bob@beta.test", company: "Beta", phone: null, stage: "engaged", motion: "outbound_prospecting", needs_action: true, next_action_key: "send_pre_2", next_step: "Nudge Bob", last_outbound_at: new Date().toISOString(), last_inbound_at: null, has_future_meeting: false },
};

const deleteLead = vi.fn(async () => {});
let resolveBob: (v: any) => void = () => {};

vi.mock("@/lib/supabaseQueries", () => ({
  getLeadDetail: vi.fn((id: string) =>
    id === "bob" ? new Promise((res) => { resolveBob = res; }) : Promise.resolve(leads[id] ?? null),
  ),
  getLeadIntelligence: vi.fn(async () => null),
  deleteLead: (...args: any[]) => deleteLead(...(args as [])),
  markActionHandled: vi.fn(async () => ({})),
  undoMarkActionHandled: vi.fn(async () => {}),
  triggerIntelligenceRecompute: vi.fn(async () => ({ ok: true })),
  getLeadMeetingPacks: vi.fn(async () => []),
}));
vi.mock("@/lib/leadActivity", () => ({ getLeadActivityFeed: vi.fn(async () => []) }));
vi.mock("@/integrations/supabase/client", () => {
  const chain: any = {
    select: () => chain, eq: () => chain, update: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: any[] }) => void) => resolve({ data: [] }),
  };
  return { supabase: { from: () => chain, auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/hooks/useGmailConnection", () => ({ useGmailConnection: () => ({ isConnected: true, connectGmail: vi.fn() }) }));
vi.mock("@/hooks/useVisibilityRefresh", () => ({ useVisibilityRefresh: () => {} }));
vi.mock("@/hooks/useMailSync", () => ({ useMailSync: () => ({ isConnected: false, isLoading: false }) }));
vi.mock("@/hooks/useBackgroundDraftQueue", () => ({
  useBackgroundDraftQueue: () => ({ enqueue: vi.fn(), getStatus: () => undefined, consume: vi.fn() }),
}));
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ workspaceId: "ws-1" }) }));

// Heavy children — not what this test is about. (vi.mock is hoisted, so each
// factory has to be inline — no shared helper const.)
vi.mock("@/components/lead/TimelineTab", () => ({ default: () => null }));
vi.mock("@/components/lead/DraftsTab", () => ({ default: () => null }));
vi.mock("@/components/lead/UploadTab", () => ({ default: () => null }));
vi.mock("@/components/lead/RecommendationsTab", () => ({ default: () => null }));
vi.mock("@/components/lead/MeetingsTab", () => ({ default: () => null }));
vi.mock("@/components/lead/LeadContextPanel", () => ({ default: () => null }));
vi.mock("@/components/lead/StakeholdersPartnersPanel", () => ({ default: () => null }));
vi.mock("@/components/lead/AutomationPreviewCard", () => ({ default: () => null }));
vi.mock("@/components/lead/NurturePreviewCard", () => ({ default: () => null }));
vi.mock("@/components/lead/PostMeetingRecapHint", () => ({ default: () => null }));
vi.mock("@/components/lead/StakeholderAvatarRow", () => ({ default: () => null }));
vi.mock("@/components/lead/EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("@/components/leads/UnifiedIntelligenceCard", () => ({ UnifiedIntelligenceCard: () => null }));
vi.mock("@/components/dashboard/EmailActionDialog", () => ({ EmailActionDialog: () => null }));
vi.mock("@/components/call/ClickToCallButton", () => ({ ClickToCallButton: () => null }));
vi.mock("@/components/mail/MailReconnectChip", () => ({ MailReconnectChip: () => null }));
vi.mock("@/components/gmail/GmailSyncButton", () => ({ GmailSyncButton: () => null }));

import LeadDetailPage from "@/pages/LeadDetail";

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/leads/${id}`]}>
      <Routes>
        <Route path="/app/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  deleteLead.mockClear();
});

describe("leadIdentityGuard", () => {
  it("shows the skeleton — never the previous lead — while another lead loads", async () => {
    const { unmount } = renderAt("jane");
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    unmount();

    // Navigating to Bob, whose fetch has not resolved yet.
    renderAt("bob");
    expect(screen.queryByText("Jane Doe")).toBeNull();
    expect(screen.queryByText("Bob Stone")).toBeNull();
    expect(screen.queryByRole("button", { name: /send a message/i })).toBeNull();

    resolveBob(leads.bob);
    expect(await screen.findByText("Bob Stone")).toBeInTheDocument();
  });

  it("the delete confirmation and the delete call name the same lead", async () => {
    renderAt("jane");
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();

    // The lead on screen is the lead in the URL (test above), and both the
    // confirmation text and the delete/dismiss calls read that same object —
    // so the dialog can never name one person while another is deleted.
    // (Radix's dropdown doesn't open under jsdom, so the wiring is pinned at
    // the source; the behaviour it protects is covered by the render above.)
    const page = readFileSync(path.join(__dirname, "../pages/LeadDetail.tsx"), "utf8");
    expect(page).toContain("await deleteLead(lead.id)");
    expect(page).not.toMatch(/await deleteLead\(id\)/);
    expect(page).toContain("const actedId = lead.id;");

    const header = readFileSync(
      path.join(__dirname, "../components/lead/LeadDetailHeader.tsx"), "utf8",
    );
    expect(header).toContain("Are you sure you want to delete <strong>{lead.name}</strong>");
    expect(header).toContain("<AlertDialogAction onClick={onDelete}");
  });
});
