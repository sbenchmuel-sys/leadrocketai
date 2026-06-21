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
vi.mock("@/lib/campaignQueries", () => ({
  createCampaignWithSteps: (...args: any[]) => createCampaignWithSteps(...args),
  deleteCampaign: (...args: any[]) => deleteCampaign(...args),
}));

const enrollLeadsInCampaign = vi.fn((..._args: any[]) => Promise.resolve());
vi.mock("@/lib/campaignEnrollment", () => ({
  enrollLeadsInCampaign: (...args: any[]) => enrollLeadsInCampaign(...args),
}));

const ingestCampaignKnowledge = vi.fn((..._args: any[]) => Promise.resolve("doc-1"));
vi.mock("@/lib/generateCampaignContent", () => ({
  ingestCampaignKnowledge: (...args: any[]) => ingestCampaignKnowledge(...args),
}));

vi.mock("@/lib/supabaseQueries", () => ({
  getLeadsList: vi.fn(async () => []),
}));

import NewCampaign from "./NewCampaign";
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
