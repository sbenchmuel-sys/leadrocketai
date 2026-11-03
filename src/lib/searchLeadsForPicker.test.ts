import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  profile: vi.fn(),
  select: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
  eq: vi.fn(),
  or: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getUser: mocks.getUser }, from: mocks.from },
}));

import { getLeadsList, searchLeadsForPicker } from "./supabaseQueries";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "rep-1" } }, error: null });
  mocks.profile.mockResolvedValue({ data: { role: "sales" }, error: null });
  const query = {
    select: mocks.select, order: mocks.order, limit: mocks.limit,
    eq: mocks.eq, or: mocks.or,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  for (const method of [mocks.select, mocks.order, mocks.limit, mocks.eq, mocks.or]) {
    method.mockReturnValue(query);
  }
  mocks.from.mockImplementation((table: string) => table === "profiles"
    ? { select: () => ({ eq: () => ({ single: mocks.profile }) }) }
    : query);
});

describe("searchLeadsForPicker", () => {
  it("loads up to 500 recent leads with the same columns and rep owner scope", async () => {
    await searchLeadsForPicker("");
    expect(mocks.limit).toHaveBeenCalledWith(500);
    expect(mocks.order).toHaveBeenCalledWith("last_activity_at", { ascending: false });
    expect(mocks.eq).toHaveBeenCalledWith("owner_user_id", "rep-1");
    expect(mocks.or).not.toHaveBeenCalled();
    const pickerColumns = mocks.select.mock.calls[0][0];
    await getLeadsList();
    expect(mocks.select.mock.calls[1][0]).toBe(pickerColumns);
    expect(mocks.limit).toHaveBeenLastCalledWith(200);
  });

  it("preserves the existing admin scope", async () => {
    mocks.profile.mockResolvedValue({ data: { role: "admin" }, error: null });
    await searchLeadsForPicker("Ada");
    expect(mocks.eq).not.toHaveBeenCalled();
    expect(mocks.or).toHaveBeenCalledWith('name.ilike."%Ada%",company.ilike."%Ada%",email.ilike."%Ada%"');
  });

  it("quotes commas and parentheses and escapes literal percent, underscore, quotes and backslashes", async () => {
    await searchLeadsForPicker('  Acme, (50%)_"\\  ');
    const value = JSON.stringify('%Acme, (50\\%)\\_"\\\\%');
    expect(mocks.or).toHaveBeenCalledWith(`name.ilike.${value},company.ilike.${value},email.ilike.${value}`);
  });

  it("rejects a signed-out request before reading leads", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(searchLeadsForPicker("Ada")).rejects.toThrow("Not logged in");
    expect(mocks.from).not.toHaveBeenCalled();
  });
});