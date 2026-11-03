// supabase-js re-emits SIGNED_IN whenever the tab becomes visible again. That must
// NOT flip isLoading (which unmounts the app to a spinner and refetches everything).
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";

const profileCalls = vi.fn();
let emit: (event: string, session: unknown) => void = () => {};
const session = { user: { id: "u1", email: "a@b.co" } };

vi.mock("@/lib/supabaseQueries", () => ({
  getCurrentProfile: vi.fn(async () => { profileCalls(); return { onboarding_done: true, role: "sales" }; }),
  createProfileIfMissing: vi.fn(async () => ({ user_id: "u1" })),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (cb: typeof emit) => { emit = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
  },
}));

import { AuthProvider, useAuth } from "@/contexts/AuthContext";

const loadingHistory: boolean[] = [];
function Probe() { loadingHistory.push(useAuth().isLoading); return null; }

describe("AuthContext tab return", () => {
  it("loads the profile once and stays loaded when SIGNED_IN is re-emitted for the same user", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { emit("INITIAL_SESSION", session); await new Promise((r) => setTimeout(r, 0)); });
    expect(loadingHistory.at(-1)).toBe(false);
    expect(profileCalls).toHaveBeenCalledTimes(1);

    loadingHistory.length = 0;
    await act(async () => { emit("SIGNED_IN", { user: { ...session.user } }); await new Promise((r) => setTimeout(r, 0)); });
    expect(loadingHistory).not.toContain(true);
    expect(profileCalls).toHaveBeenCalledTimes(1);

    // A genuinely different user still triggers a full load.
    await act(async () => { emit("SIGNED_IN", { user: { id: "u2" } }); await new Promise((r) => setTimeout(r, 0)); });
    expect(profileCalls).toHaveBeenCalledTimes(2);
  });
});
