import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ search: vi.fn(), preview: vi.fn(), enroll: vi.fn() }));
vi.mock("@/lib/supabaseQueries", () => ({ searchLeadsForPicker: mocks.search }));
vi.mock("@/lib/campaignEnrollment", () => ({
  previewEnrollment: mocks.preview, enrollLeadsInCampaign: mocks.enroll,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { AddLeadsDialog } from "./AddLeadsDialog";

const initial = [
  { id: "1", name: "Ada", company: "Engines", email: "ada@example.com" },
  { id: "2", name: "Excluded", company: "Navy", email: "excluded@example.com" },
];
const older = [{ id: "600", name: "Older Person", company: "Archive", email: "older@example.com" }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.mockImplementation(async (search: string) => search ? older : initial);
  mocks.preview.mockResolvedValue({ enrollableCount: 2, skips: {}, channelSkips: { lines: [] } });
});

describe("AddLeadsDialog picker", () => {
  it("loads on open, excludes existing people, and preserves selections across server searches", async () => {
    render(<AddLeadsDialog open onOpenChange={vi.fn()} campaignId="campaign-1" excludeIds={["2"]} onAdded={vi.fn()} />);
    await screen.findByText("Ada");
    expect(mocks.search).toHaveBeenCalledWith("");
    expect(screen.queryByText("Excluded")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    const search = screen.getByPlaceholderText("Search by name, company, or email");
    fireEvent.change(search, { target: { value: "Older" } });
    await screen.findByText("Older Person");
    expect(mocks.search).toHaveBeenLastCalledWith("Older");
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    await screen.findByText("Ada");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledWith("campaign-1", ["1", "600"]));
    expect(mocks.enroll).not.toHaveBeenCalled();
  });

  it("ignores an old search response arriving after a newer search", async () => {
    let resolveOld: ((rows: typeof older) => void) | undefined;
    mocks.search.mockImplementation((search: string) => search === "old"
      ? new Promise<typeof older>((resolve) => { resolveOld = resolve; })
      : Promise.resolve(search ? older : initial));
    render(<AddLeadsDialog open onOpenChange={vi.fn()} campaignId="campaign-1" excludeIds={[]} onAdded={vi.fn()} />);
    await screen.findByText("Ada");
    const search = screen.getByPlaceholderText("Search by name, company, or email");
    fireEvent.change(search, { target: { value: "old" } });
    await waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith("old"));
    fireEvent.change(search, { target: { value: "Older" } });
    await screen.findByText("Older Person");
    resolveOld?.([]);
    await waitFor(() => expect(screen.getByText("Older Person")).toBeInTheDocument());
  });
});