// Unit L2 — guards for the one-column lead page.
//
// Two styles, deliberately:
//  • React Testing Library renders LeadDetailHeader for the things a rep can
//    actually see (one primary button, the provenance line, the chips).
//  • Source-text scans (same style as src/test/coldAutoSendGate.test.ts) for
//    structural promises that are cheaper and more honest to assert against the
//    file than against a mocked DOM — no desktop rail, the automation chip
//    writing the same fields, the overflow-menu contents, and the
//    feature-preservation checklist that stops a later refactor quietly
//    dropping a control.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const ROOT = path.resolve(__dirname, "../..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const LEAD_DETAIL = "src/pages/LeadDetail.tsx";
const HEADER = "src/components/lead/LeadDetailHeader.tsx";
const TOGGLE = "src/components/lead/AutomationToggleCard.tsx";
const TIMELINE = "src/components/lead/TimelineTab.tsx";
const INTEL_CARD = "src/components/leads/UnifiedIntelligenceCard.tsx";

/* ── Mocks for the RTL renders ───────────────────────────────────────── */

vi.mock("@/integrations/supabase/client", () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    update: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: any[] }) => void) => resolve({ data: [] }),
  };
  return { supabase: { from: () => chain, auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/hooks/useMailSync", () => ({ useMailSync: () => ({ isConnected: true, isLoading: false }) }));
vi.mock("@/hooks/useGmailConnection", () => ({ useGmailConnection: () => ({ isConnected: true, connectGmail: vi.fn() }) }));
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ workspaceId: "ws-1" }) }));
vi.mock("@/components/call/ClickToCallButton", () => ({
  ClickToCallButton: () => <button type="button">Call</button>,
}));
vi.mock("@/components/lead/StakeholderAvatarRow", () => ({ default: () => null }));
vi.mock("@/components/mail/MailReconnectChip", () => ({ MailReconnectChip: () => null }));
vi.mock("@/components/gmail/GmailSyncButton", () => ({ GmailSyncButton: () => <button type="button">Refresh</button> }));
vi.mock("@/hooks/useBackgroundDraftQueue", () => ({
  useBackgroundDraftQueue: () => ({ enqueue: vi.fn(), getStatus: () => undefined, consume: vi.fn() }),
}));

import LeadDetailHeader from "@/components/lead/LeadDetailHeader";
import type { LeadDetail, LeadIntelligence } from "@/lib/supabaseQueries";

const DAY = 24 * 60 * 60 * 1000;

function makeLead(overrides: Partial<LeadDetail> = {}): LeadDetail {
  return {
    id: "lead-1",
    name: "Dana Chen",
    email: "dana@acme.test",
    company: "Acme",
    job_title: "Head of Ops",
    phone: null,
    stage: "engaged",
    motion: "outbound_prospecting",
    needs_action: true,
    next_action_key: "send_pre_2",
    next_step: "Send a short nudge about the pricing question",
    next_step_reason: "They asked for pricing four days ago",
    last_outbound_at: new Date(Date.now() - 3 * DAY).toISOString(),
    last_inbound_at: null,
    has_future_meeting: false,
    milestones_json: null,
    ...overrides,
  } as unknown as LeadDetail;
}

function renderHeader(lead: LeadDetail, intelligence: LeadIntelligence | null = null) {
  return render(
    <MemoryRouter>
      <LeadDetailHeader
        lead={lead}
        intelligence={intelligence}
        isConnected
        isDeleting={false}
        originContext="leads"
        onDelete={vi.fn()}
        onUpdate={vi.fn()}
        onSyncComplete={vi.fn()}
        onDraftIt={vi.fn()}
        onMarkHandled={vi.fn()}
        onOpenDeal={vi.fn()}
        onAddMessage={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ── 1. One column, no desktop-only rail ─────────────────────────────── */

describe("oneColumnNoDesktopRail", () => {
  it("LeadDetail has no desktop-only right rail and no multi-column grid", () => {
    const s = src(LEAD_DETAIL);
    expect(s).not.toMatch(/hidden\s+lg:block/);
    expect(s).not.toMatch(/lg:grid-cols-/);
    expect(s).not.toMatch(/lg:col-span-/);
  });

  it("the rail component it wrapped is gone and nothing imports it", () => {
    expect(existsSync(path.join(ROOT, "src/components/lead/LeadOverviewPanel.tsx"))).toBe(false);
    expect(src(LEAD_DETAIL)).not.toContain("LeadOverviewPanel");
    // Unused pre-Unit-2 header component, deleted per the plan.
    expect(existsSync(path.join(ROOT, "src/components/lead/MeetingPackHeader.tsx"))).toBe(false);
  });

  it("the automation switch renders for every screen size (no lg: gate around it)", () => {
    const s = src(HEADER);
    expect(s).toContain("<AutomationToggleCard");
    expect(s).not.toMatch(/lg:hidden|hidden\s+lg:/);
  });
});

/* ── 2. The automation chip writes exactly the old fields ────────────── */

describe("automationChipWritesSameFields", () => {
  const s = src(TOGGLE);

  it("uses the shared leadAutomationActions field builders — not inline field literals", () => {
    expect(s).toContain('from "@/lib/leadAutomationActions"');
    expect(s).toContain("AUTOMATION_DISABLE_FIELDS");
    expect(s).toContain("buildAutomationEnableFields");
    expect(s).toMatch(/from\("leads"\)\.update\(AUTOMATION_DISABLE_FIELDS\)\.eq\("id", lead\.id\)/);
    expect(s).toMatch(/from\("leads"\)\.update\(buildAutomationEnableFields\(lead\)\)\.eq\("id", lead\.id\)/);
    // No hand-rolled automation field writes crept in with the chip rewrite.
    expect(s).not.toMatch(/automation_mode:\s*"/);
    expect(s).not.toMatch(/eligible_at:\s*(?!null)/);
  });

  it("keeps the resume blocker guard and the turn-on confirm dialog", () => {
    expect(s).toContain("getAutomationResumeBlocker(lead)");
    expect(s).toContain("setConfirmOpen(true)");
    expect(s).toContain("Turn on automation for this lead?");
    // Turning OFF stays immediate (no confirm) — unchanged behaviour.
    expect(s).toContain("Turning off is always safe");
  });

  it("is rendered as the chip in the header chip row", () => {
    expect(src(HEADER)).toContain("<AutomationToggleCard lead={lead} onUpdate={onUpdate} />");
    expect(s).toContain("<Switch");
  });
});

/* ── 3. Exactly one primary message button ───────────────────────────── */

describe("singleDraftButton", () => {
  it("renders one message button and no second draft button", () => {
    renderHeader(makeLead());
    expect(screen.getAllByRole("button", { name: /send a message/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /draft it/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /draft re-engagement/i })).toBeNull();
  });

  it("a re-engagement lead gets 'Win them back' INSTEAD of the message button", () => {
    const lead = makeLead({
      motion: "inbound_response",
      next_action_key: null,
      last_inbound_at: new Date(Date.now() - 20 * DAY).toISOString(),
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
    } as Partial<LeadDetail>);
    renderHeader(lead);
    expect(screen.getAllByRole("button", { name: /win them back/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /send a message/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /draft re-engagement/i })).toBeNull();
  });

  it("keeps the reversible 'Already did it' action", () => {
    renderHeader(makeLead());
    expect(screen.getByRole("button", { name: /already did it/i })).toBeInTheDocument();
  });
});

/* ── 4. Provenance is always visible ─────────────────────────────────── */

describe("provenanceAlwaysVisible", () => {
  it("shows what the suggestion was built from plus an Update control", () => {
    const intel = {
      recommended_next_step: "Send a short nudge",
      next_step_reason: "They asked for pricing",
      last_computed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      source_counts_json: { timeline_items: 12, meetings: 1 },
    } as unknown as LeadIntelligence;
    renderHeader(makeLead(), intel);
    expect(screen.getByText(/From 12 messages and 1 meeting/i)).toBeInTheDocument();
    expect(screen.getByText(/checked about 2 hours ago/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^update$/i })).toBeInTheDocument();
  });

  it("still shows the line when the lead has never been analysed", () => {
    renderHeader(makeLead(), null);
    expect(screen.getByText(/not checked yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^update$/i })).toBeInTheDocument();
  });

  it("the intelligence card no longer hides its age + Update in compact mode", () => {
    const s = src(INTEL_CARD);
    expect(s).not.toMatch(/\{!isCompact && \(\s*<CardHeader/);
    expect(s).not.toContain('{isAnalyzing ? "Analyzing…" : "Run Analysis"}');
    expect(s).toContain('{isAnalyzing ? "Updating…" : "Update"}');
  });
});

/* ── 5. Nothing rep-facing went missing ──────────────────────────────── */

describe("featurePreservation", () => {
  const page = src(LEAD_DETAIL);
  const header = src(HEADER);
  const timeline = src(TIMELINE);
  const preview = src("src/components/lead/AutomationPreviewCard.tsx");

  const KEPT: [string, () => boolean][] = [
    ["slow-drip (nurture) preview", () => page.includes("<NurturePreviewCard")],
    ["automation details card", () => page.includes("<AutomationPreviewCard")],
    ["automation Preview / Pause / Resume / Stop / Disable", () =>
      ["Preview", "Pause", "Resume", "Stop Sequence", "Disable Automation"].every(t => preview.includes(t))],
    ["sequence preview dialog", () => preview.includes("AutomationDraftPreviewDialog") && preview.includes("<CampaignStepPreview")],
    ["other people at this company", () => page.includes("<StakeholdersPartnersPanel")],
    ["lead context items", () => page.includes("<LeadContextPanel")],
    ["upload files", () => page.includes("<UploadTab")],
    ["saved drafts", () => page.includes("<DraftsTab")],
    ["meetings", () => page.includes("<MeetingsTab")],
    ["what we know + interactive milestones/risks", () =>
      page.includes("<UnifiedIntelligenceCard") && page.includes("<RecommendationsTab")],
    ["history", () => page.includes("<TimelineTab")],
    ["call + whatsapp in the action row", () =>
      header.includes("<ClickToCallButton") && header.includes("whatsappLink(")],
    ["timeline filters (once the lead has history)", () =>
      timeline.includes("showFilters") && timeline.includes("FILTER_OPTIONS")],
    ["show-hidden toggle", () => timeline.includes("setShowHidden(!showHidden)")],
    ["log an inbound message", () => timeline.includes("handleLogWhatsAppReply")],
    ["mark-handled (Already did it)", () => header.includes("onMarkHandled")],
    ["post-meeting recap hint", () => page.includes("<PostMeetingRecapHint")],
    ["automation hand-back reason (manual_mode)", () => header.includes("lead.manual_mode_reason")],
    ["country on the identity line", () => header.includes("lead.country")],
  ];

  for (const [name, check] of KEPT) {
    it(`still reachable: ${name}`, () => {
      expect(check()).toBe(true);
    });
  }

  it("removes only the chrome the plan lists", () => {
    expect(src("src/components/lead/CampaignStepPreview.tsx")).not.toContain("step.framework");
    expect(src("src/components/lead/CampaignStepPreview.tsx")).not.toContain("cta_type");
    expect(src("src/components/lead/CampaignStepPreview.tsx")).not.toContain("hard_rules.length");
    expect(src("src/components/lead/LeadContextPanel.tsx")).not.toContain("Used by AI");
    expect(src("src/components/lead/LeadContextPanel.tsx")).not.toContain("col: ");
    expect(src("src/components/lead/DraftsTab.tsx")).not.toMatch(/>\s*No KB\s*</);
    expect(src(INTEL_CARD)).not.toContain("confidence_score * 100");
  });
});

/* ── 6. The overflow menu holds the secondary actions ────────────────── */

describe("overflowMenuContents", () => {
  const s = src(HEADER);
  const menu = s.slice(s.indexOf("<DropdownMenuContent"), s.indexOf("</DropdownMenuContent>"));

  it("holds Text, Edit, Add a message, mailbox sync and Delete", () => {
    expect(menu).toContain("Text");
    expect(menu).toContain("Edit details");
    expect(menu).toContain("Add a message");
    expect(menu).toContain("<GmailSyncButton");
    expect(menu).toContain("Delete lead");
  });

  it("Delete still goes through the confirm dialog", () => {
    expect(menu).toContain("setDeleteOpen(true)");
    expect(s).toContain("<AlertDialogTitle>Delete Lead</AlertDialogTitle>");
    expect(s).toContain("Are you sure you want to delete");
  });

  it("the timeline's own add-message button is suppressed when the page controls it", () => {
    expect(src(TIMELINE)).toContain("!addMessageControlled && (");
    expect(src(LEAD_DETAIL)).toContain("onAddMessageOpenChange={setAddMessageOpen}");
  });
});

/* ── 7. Chip wording (pure helpers) ──────────────────────────────────── */

describe("headerChipWording", () => {
  it("says what a rep would say", async () => {
    const { buildStatusChip, buildAwayChip, buildProvenanceLine } =
      await import("@/components/lead/leadHeaderText");
    const now = new Date("2026-09-08T12:00:00Z");

    expect(buildStatusChip(makeLead({
      last_inbound_at: new Date("2026-09-06T12:00:00Z").toISOString(),
      last_outbound_at: new Date("2026-09-01T12:00:00Z").toISOString(),
    }), now)).toBe("Replied 2 days ago");

    expect(buildStatusChip(makeLead({
      last_inbound_at: null,
      last_outbound_at: new Date("2026-09-05T12:00:00Z").toISOString(),
    }), now)).toBe("Waiting 3 days");

    expect(buildStatusChip(makeLead({ has_future_meeting: true }), now)).toBe("Meeting booked");
    expect(buildStatusChip(makeLead({ last_inbound_at: null, last_outbound_at: null }), now)).toBe("No outreach yet");

    expect(buildAwayChip("2026-09-12T00:00:00Z", now)).toBe("Away until Sep 12");
    expect(buildAwayChip("2026-09-01T00:00:00Z", now)).toBeNull();
    expect(buildAwayChip(null, now)).toBeNull();

    expect(buildProvenanceLine({ sourceCounts: null, lastComputedAt: null }))
      .toBe("Nothing to read yet · not checked yet");
    expect(buildProvenanceLine({ sourceCounts: { timeline_items: 1, meetings: 0 }, lastComputedAt: null }))
      .toBe("From 1 message · not checked yet");
  });
});

/* ── 8. QA round 1 fixes ─────────────────────────────────────────────── */

describe("automationChipIsReadableAndTappable", () => {
  it("shows the status sentence as visible text, not a tooltip", () => {
    renderHeader(makeLead({ automation_mode: null } as Partial<LeadDetail>));
    expect(screen.getByText(/turn on and we'll send the follow-ups for you/i)).toBeInTheDocument();
    // The old hover-only tooltip is gone.
    expect(src(TOGGLE)).not.toContain("title={description}");
  });

  it("gives the switch a 44px hit area", () => {
    // Transparent pseudo-element around the 24px switch → 44px tappable.
    expect(src(TOGGLE)).toContain("before:-inset-y-2.5");
  });

  it("does not contradict a running slow drip", () => {
    expect(src(TOGGLE)).toContain('if (motion === "nurture") return null;');
    const { container } = renderHeader(makeLead({ motion: "nurture" } as Partial<LeadDetail>));
    expect(container.textContent).not.toMatch(/Automation (on|off|paused)/);
  });

  it("keeps the hand-back reason visible when automation was paused for the rep", () => {
    renderHeader(makeLead({
      manual_mode: true,
      manual_mode_reason: "More people joined the thread",
    } as Partial<LeadDetail>));
    expect(screen.getByText("Automation paused")).toBeInTheDocument();
    expect(screen.getByText(/More people joined the thread/)).toBeInTheDocument();
  });
});
