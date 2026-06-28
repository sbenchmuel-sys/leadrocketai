import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ── Mocks ───────────────────────────────────────────────────────────────────
// Supabase client: the only call NewCampaign makes directly is the sms_enabled
// lookup in a useEffect (from().select().eq().single()).
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { sms_enabled: false } }),
        }),
      }),
    }),
  },
}));

vi.mock("@/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1" }),
}));

const navigateMock = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const createCampaignWithSteps = vi.fn((..._args: any[]) => Promise.resolve("camp-1"));
const deleteCampaign = vi.fn((..._args: any[]) => Promise.resolve());
// Existing workspace outreaches — drives the save-time name de-duplication.
// Default: none, so names pass through untouched.
const fetchWorkspaceCampaigns = vi.fn(async (..._args: any[]): Promise<any[]> => []);
vi.mock("@/lib/campaignQueries", () => ({
  createCampaignWithSteps: (...args: any[]) => createCampaignWithSteps(...args),
  deleteCampaign: (...args: any[]) => deleteCampaign(...args),
  fetchWorkspaceCampaigns: (...args: any[]) => fetchWorkspaceCampaigns(...args),
}));

const enrollLeadsInCampaign = vi.fn((..._args: any[]) => Promise.resolve());
vi.mock("@/lib/campaignEnrollment", () => ({
  enrollLeadsInCampaign: (...args: any[]) => enrollLeadsInCampaign(...args),
}));

const ingestCampaignKnowledge = vi.fn((..._args: any[]) => Promise.resolve("doc-1"));
vi.mock("@/lib/generateCampaignContent", () => ({
  ingestCampaignKnowledge: (...args: any[]) => ingestCampaignKnowledge(...args),
}));

const getLeadsList = vi.fn(async (..._args: any[]): Promise<any[]> => []);
vi.mock("@/lib/supabaseQueries", () => ({
  getLeadsList: (...args: any[]) => getLeadsList(...args),
}));

import NewCampaign, { filterLeads } from "./NewCampaign";
import { toast } from "sonner";

function renderWizard() {
  return render(
    <MemoryRouter>
      <NewCampaign />
    </MemoryRouter>,
  );
}

// Drive the wizard to the final "Save outreach" button with a flyer attached
// and no recipients selected (keeps enrollment out of the picture).
async function reachConfirmWithFlyer(container: HTMLElement, file: File) {
  fireEvent.change(screen.getByLabelText(/What's this outreach called/i), {
    target: { value: "Spring promo" },
  });
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [file] } });

  fireEvent.click(screen.getByRole("button", { name: /Build my outreach/i }));
  fireEvent.click(await screen.findByRole("button", { name: /Looks good/i }));
  // Step 3 loads recipients (mocked to []) — wait for the Save button.
  return screen.findByRole("button", { name: /Save outreach/i });
}

function makeFlyer(): File {
  const f = new File(["a one-pager about the spring promo"], "flyer.txt", {
    type: "text/plain",
  });
  // jsdom doesn't reliably implement Blob.text(); make it deterministic.
  Object.defineProperty(f, "text", {
    value: () => Promise.resolve("a one-pager about the spring promo"),
  });
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NewCampaign — flyer upload", () => {
  it("ingests the attached flyer through the campaign-knowledge path after creating the campaign", async () => {
    const { container } = renderWizard();
    const saveBtn = await reachConfirmWithFlyer(container, makeFlyer());
    fireEvent.click(saveBtn);

    await waitFor(() => expect(createCampaignWithSteps).toHaveBeenCalledTimes(1));
    // knowledge_ref is left null at creation — the ingest path sets it on success.
    expect(createCampaignWithSteps.mock.calls[0][0]).toMatchObject({ knowledge_ref: null });

    await waitFor(() => expect(ingestCampaignKnowledge).toHaveBeenCalledTimes(1));
    expect(ingestCampaignKnowledge).toHaveBeenCalledWith(
      "camp-1",
      "a one-pager about the spring promo",
      "flyer.txt",
    );

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/app/automations/camp-1"));
  });

  it("saves anyway (no rollback) and flags it when the flyer can't be read", async () => {
    ingestCampaignKnowledge.mockRejectedValueOnce(
      new Error("That file didn't have enough readable text"),
    );

    const { container } = renderWizard();
    const saveBtn = await reachConfirmWithFlyer(container, makeFlyer());
    fireEvent.click(saveBtn);

    await waitFor(() => expect(ingestCampaignKnowledge).toHaveBeenCalledTimes(1));
    // The campaign must NOT be rolled back for a bad flyer — it's optional.
    expect(deleteCampaign).not.toHaveBeenCalled();
    // Save still completes and navigates.
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/app/automations/camp-1"));
    expect(toast.success).toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/couldn't read that file/i));
  });

  it("doesn't touch the knowledge path when no flyer is attached", async () => {
    const { container } = renderWizard();
    fireEvent.change(screen.getByLabelText(/What's this outreach called/i), {
      target: { value: "No-flyer promo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Build my outreach/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Looks good/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Save outreach/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/app/automations/camp-1"));
    expect(ingestCampaignKnowledge).not.toHaveBeenCalled();
    expect(container).toBeTruthy();
  });
});

// ── filterLeads (pure) ────────────────────────────────────────────────────────
describe("filterLeads", () => {
  const leads: any[] = [
    { id: "1", name: "Ada Lovelace", company: "Analytical Engines", email: "ada@ae.com" },
    { id: "2", name: "Grace Hopper", company: "Navy", email: "grace@navy.mil" },
    { id: "3", name: "Alan Turing", company: "Bletchley", email: "alan@bp.uk" },
  ];

  it("returns the full list for an empty/whitespace query", () => {
    expect(filterLeads(leads, "")).toHaveLength(3);
    expect(filterLeads(leads, "   ")).toHaveLength(3);
  });

  it("matches on name, company, or email, case-insensitively", () => {
    expect(filterLeads(leads, "grace").map((l) => l.id)).toEqual(["2"]);
    expect(filterLeads(leads, "bletchley").map((l) => l.id)).toEqual(["3"]);
    expect(filterLeads(leads, "AE.COM").map((l) => l.id)).toEqual(["1"]);
  });

  it("tolerates null fields", () => {
    const withNulls: any[] = [{ id: "9", name: null, company: null, email: null }];
    expect(filterLeads(withNulls, "anything")).toHaveLength(0);
  });
});

// ── Step 3: recipient search + select-all ─────────────────────────────────────
describe("NewCampaign — recipient search & select all", () => {
  const sampleLeads: any[] = [
    { id: "1", name: "Ada Lovelace", company: "Analytical Engines", email: "ada@ae.com" },
    { id: "2", name: "Grace Hopper", company: "Navy", email: "grace@navy.mil" },
    { id: "3", name: "Alan Turing", company: "Bletchley", email: "alan@bp.uk" },
  ];

  async function reachRecipients() {
    getLeadsList.mockResolvedValue(sampleLeads);
    renderWizard();
    fireEvent.change(screen.getByLabelText(/What's this outreach called/i), {
      target: { value: "Outreach" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Build my outreach/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Looks good/i }));
    // Wait for the (mocked) leads to render on Step 3.
    await screen.findByText("Ada Lovelace");
  }

  it("narrows the visible list as the rep types in the search box", async () => {
    await reachRecipients();
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.getByText("Alan Turing")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search people"), {
      target: { value: "grace" },
    });

    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(screen.queryByText("Alan Turing")).not.toBeInTheDocument();
  });

  it("'Select all' selects only the filtered set, not hidden leads", async () => {
    await reachRecipients();

    // Filter down to a single person, then select all visible.
    fireEvent.change(screen.getByPlaceholderText("Search people"), {
      target: { value: "grace" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Select all/i }));

    // Only the one filtered lead is selected — the summary reflects 1 person.
    expect(screen.getByText(/to 1 person/i)).toBeInTheDocument();
    // The control flips to "Clear" once everything visible is selected.
    expect(screen.getByRole("button", { name: /Clear/i })).toBeInTheDocument();

    // Clearing the search reveals the other (still-unselected) leads, and since
    // not all visible are selected anymore the control returns to "Select all".
    fireEvent.change(screen.getByPlaceholderText("Search people"), {
      target: { value: "" },
    });
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Select all/i })).toBeInTheDocument();
    // Still just the one selection — hidden leads were never touched.
    expect(screen.getByText(/to 1 person/i)).toBeInTheDocument();
  });
});

// ── Starter cadence → editable plan (joins Unit 1 + Unit 2) ───────────────────
// Picking a starter must PREFILL the same Step-2 editor the custom path uses —
// not create up front — so the rep can shape it before any draft exists.
describe("NewCampaign — starter cadence prefills the editable plan", () => {
  // Click a starter card by its name, landing on the Step-2 editor.
  function pickStarter(name: RegExp) {
    fireEvent.click(screen.getByRole("button", { name }));
  }

  // Step 2 → Step 3 → Save, returning the steps[] passed to createCampaignWithSteps.
  async function saveAndReadSteps() {
    fireEvent.click(await screen.findByRole("button", { name: /Looks good/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Save outreach/i }));
    await waitFor(() => expect(createCampaignWithSteps).toHaveBeenCalledTimes(1));
    return createCampaignWithSteps.mock.calls[0][0];
  }

  it("does NOT create a campaign on pick — it drops into the editable plan", async () => {
    renderWizard();
    pickStarter(/Inbound Intro/i);

    // Nothing written yet; the rep is in the Step-2 editor.
    expect(createCampaignWithSteps).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    // Step-2 heading echoes the picked starter so the rep can confirm it.
    expect(
      await screen.findByText(/Here's your Inbound Intro outreach/i),
    ).toBeInTheDocument();
  });

  it("lands the preset's steps in the plan and saves them under the starter's name", async () => {
    renderWizard();
    pickStarter(/Inbound Intro/i);
    const input = await saveAndReadSteps();

    // The campaign-level identity comes from the starter, not the (untouched) form.
    expect(input).toMatchObject({ name: "Inbound Intro", campaign_type: "general" });
    expect(input.global_instructions).toMatch(/Use the text only/i);
    // Inbound Intro is a 7-touch email/call/text mix — all of it carried over.
    expect(input.steps).toHaveLength(7);
    expect(input.steps.map((s: any) => s.channel)).toEqual([
      "email", "voice", "email", "sms", "email", "voice", "email",
    ]);
    // send_mode is never set here — the draft inherits the DB default 'review'.
    expect(input).not.toHaveProperty("send_mode");
  });

  it("persists a touch ADDED before save (add a call → save → it's there)", async () => {
    renderWizard();
    pickStarter(/Inbound Intro/i);

    // Expand the last "Add a step" zone (append at the end) and add a call.
    const addZones = await screen.findAllByRole("button", { name: /Add a step/i });
    fireEvent.click(addZones[addZones.length - 1]);
    fireEvent.click(await screen.findByRole("button", { name: /Add a call/i }));

    const input = await saveAndReadSteps();
    // 7 → 8 touches; the appended one is the call (voice), bringing voice to 3.
    expect(input.steps).toHaveLength(8);
    expect(input.steps.filter((s: any) => s.channel === "voice")).toHaveLength(3);
    expect(input.steps[input.steps.length - 1].channel).toBe("voice");
  });

  it("persists a meeting-link tick set before save", async () => {
    renderWizard();
    pickStarter(/Inbound Intro/i);

    // The first email touch's "Include a meeting link" checkbox is the first one.
    const checkbox = (await screen.findAllByRole("checkbox"))[0];
    fireEvent.click(checkbox);

    const input = await saveAndReadSteps();
    expect(input.steps[0].channel).toBe("email");
    expect(input.steps[0].include_meeting_cta).toBe(true);
    // Untouched email touches stay on inherit (null) — only the ticked one flips.
    expect(input.steps[2].include_meeting_cta ?? null).toBeNull();
  });

  it("switching from a starter to 'Build my outreach' leaves no stale starter steps", async () => {
    renderWizard();
    pickStarter(/Inbound Intro/i); // 7-touch starter plan
    await screen.findByText(/Here's your Inbound Intro outreach/i);

    // Back to Step 1, then take the custom path with a fresh name.
    // Two "Back" controls at Step 2 (header arrow + inline) — either returns to Step 1.
    fireEvent.click(screen.getAllByRole("button", { name: /^Back$/i })[0]);
    fireEvent.change(screen.getByLabelText(/What's this outreach called/i), {
      target: { value: "My own outreach" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Build my outreach/i }));

    const input = await saveAndReadSteps();
    // Custom path: the default 9-touch plan and the FORM's name — not the starter's.
    expect(input.name).toBe("My own outreach");
    expect(input.steps).toHaveLength(9);
  });

  it("auto-suffixes the name when the same starter is added twice", async () => {
    // The workspace already has an "Inbound Intro" — the second one must not
    // collide. The rep can still rename later; this just keeps them apart.
    fetchWorkspaceCampaigns.mockResolvedValueOnce([{ name: "Inbound Intro" }]);

    renderWizard();
    pickStarter(/Inbound Intro/i);
    const input = await saveAndReadSteps();

    expect(input.name).toBe("Inbound Intro 2");
    // The rep is told what happened, in plain language.
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/saved this one as "Inbound Intro 2"/i));
  });

  it("switching from the custom path to a starter replaces the custom plan", async () => {
    renderWizard();
    // Custom path first → 9-touch default plan.
    fireEvent.change(screen.getByLabelText(/What's this outreach called/i), {
      target: { value: "Scratch build" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Build my outreach/i }));
    await screen.findByText(/Here's your outreach/i);

    // Back, then pick a starter — its plan must fully replace the custom one.
    // Two "Back" controls at Step 2 (header arrow + inline) — either returns to Step 1.
    fireEvent.click(screen.getAllByRole("button", { name: /^Back$/i })[0]);
    pickStarter(/Cold Outbound/i);

    const input = await saveAndReadSteps();
    expect(input.name).toBe("Cold Outbound");
    expect(input.steps).toHaveLength(4); // Cold Outbound is a 4-email sequence
    expect(input.steps.every((s: any) => s.channel === "email")).toBe(true);
  });

  it("does not offer the Re-engage starter (hidden until the per-lead engine ships)", () => {
    renderWizard();
    // Step 1 shows the picker; Re-engage is intentionally not among the cards.
    expect(screen.getByRole("button", { name: /Inbound Intro/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cold Outbound/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Re-engage/i })).toBeNull();
  });
});
