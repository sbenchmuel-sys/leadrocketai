// ============================================================
// Settings → Calls / Voice card. BEHAVIOURAL — renders the real card
// against a fake PostgREST client.
//
// The bug this pins: a workspace with no call_settings row got a dead
// card. The load-time insert failed, supabase-js resolved `{ error }`
// instead of throwing, nobody read it, and Save had no row to update —
// so the caller ID the admin typed was never stored and every browser
// call from that workspace was refused.
// ============================================================
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

type Call = { fn: string; args: unknown[] };
let chains: Call[][] = [];
let resolve: (chain: Call[]) => { data: unknown; error: unknown };

function builder(chain: Call[]): unknown {
  return new Proxy(() => undefined, {
    get(_t, prop) {
      if (prop === "then") {
        chains.push(chain);
        return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(resolve(chain)).then(ok, bad);
      }
      return (...args: unknown[]) => builder([...chain, { fn: String(prop), args }]);
    },
  });
}
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => builder([{ fn: "from", args: [table] }]) },
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}));

const { CallSettingsCard } = await import("@/components/settings/CallSettingsCard");

const WS = "9c92f7ce-0000-4000-8000-000000000001";
const has = (chain: Call[], fn: string) => chain.some((c) => c.fn === fn);
const writes = () => chains.filter((c) => has(c, "upsert") || has(c, "insert") || has(c, "update"));

async function typeNumberAndSave(number: string) {
  const input = await screen.findByLabelText(/Default Twilio Caller ID/i);
  fireEvent.change(input, { target: { value: number } });
  fireEvent.click(screen.getByRole("button", { name: /Save Settings/i }));
}

beforeEach(() => {
  chains = [];
  toastError.mockClear();
  toastSuccess.mockClear();
});

describe("CallSettingsCard", () => {
  it("no existing row → form renders with defaults, and Save creates the row", async () => {
    resolve = () => ({ data: null, error: null });
    render(<CallSettingsCard workspaceId={WS} />);

    // Defaults are on screen without any write having happened at load time.
    expect(await screen.findByDisplayValue("en-US")).toBeInTheDocument();
    expect(writes()).toHaveLength(0);

    await typeNumberAndSave(" +15551234567 ");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Call settings saved"));

    const upsert = writes()[0].find((c) => c.fn === "upsert")!;
    expect(upsert.args[0]).toMatchObject({ workspace_id: WS, default_twilio_number: "+15551234567", audio_retention_days: 90 });
    expect(upsert.args[1]).toEqual({ onConflict: "workspace_id" });
  });

  it("existing row → Save updates that workspace's row with the edited values", async () => {
    resolve = (chain) =>
      has(chain, "select")
        ? { data: { id: "row-1", workspace_id: WS, transcribe_min_duration_sec: 10, analyze_min_duration_sec: 30, default_language: "he-IL", supported_languages: ["he-IL"], recording_notice_enabled: true, recording_require_dtmf_consent: false, audio_retention_days: 30, default_twilio_number: "+15550000000" }, error: null }
        : { data: null, error: null };
    render(<CallSettingsCard workspaceId={WS} />);

    expect(await screen.findByDisplayValue("+15550000000")).toBeInTheDocument();
    await typeNumberAndSave("+15559999999");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

    expect(writes()).toHaveLength(1);
    const upsert = writes()[0].find((c) => c.fn === "upsert")!;
    expect(upsert.args[0]).toMatchObject({ workspace_id: WS, default_twilio_number: "+15559999999", default_language: "he-IL", audio_retention_days: 30 });
    expect(upsert.args[1]).toEqual({ onConflict: "workspace_id" });
  });

  it("a failed write is shown to the user with the database's message, not swallowed", async () => {
    resolve = (chain) =>
      has(chain, "upsert")
        ? { data: null, error: { message: "new row violates row-level security policy" } }
        : { data: null, error: null };
    render(<CallSettingsCard workspaceId={WS} />);

    await typeNumberAndSave("+15551234567");
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Failed to save settings",
        expect.objectContaining({ description: expect.stringContaining("row-level security") }),
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("a failed load is shown to the user too", async () => {
    resolve = () => ({ data: null, error: { message: "permission denied for table call_settings" } });
    render(<CallSettingsCard workspaceId={WS} />);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't load call settings",
        expect.objectContaining({ description: "permission denied for table call_settings" }),
      ),
    );
  });
});
