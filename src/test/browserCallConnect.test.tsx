// ============================================================
// Browser calling — a call that cannot start must SAY so.
//
// BEHAVIOURAL: renders the real BrowserCallProvider against a fake Twilio
// Device. (`callingSafety.test.ts` next door scans source text and has no
// DOM, so these live in their own file.)
//
// The bug this pins: with the microphone blocked, the Twilio SDK waited on
// the permission inside connect() and the rep stared at "Connecting…"
// forever with no message.
// ============================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const connect = vi.fn();
const disconnectAll = vi.fn();

vi.mock("@twilio/voice-sdk", () => {
  class Device {
    static State = { Destroyed: "destroyed", Registered: "registered", Registering: "registering" };
    state = "registered";
    identity = "test-rep";
    audio = undefined;
    private handlers: Record<string, () => void> = {};
    on(event: string, fn: () => void) { this.handlers[event] = fn; }
    async register() { this.handlers.registered?.(); }
    updateToken() {}
    destroy() {}
    connect = connect;
    disconnectAll = disconnectAll;
  }
  return { Device, Call: class {} };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: "jwt" } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  },
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

const { BrowserCallProvider, useBrowserCall } = await import("@/components/call/BrowserCallProvider");

let ctx: ReturnType<typeof useBrowserCall>;
function Probe() {
  ctx = useBrowserCall();
  return null;
}

const getUserMedia = vi.fn();
const CALL = { toNumber: "+15551230000", fromNumber: "+15559990000", leadId: "lead-1", leadName: "Bob the Builder" };

async function renderReady() {
  render(<BrowserCallProvider><Probe /></BrowserCallProvider>);
  await waitFor(() => expect(ctx.status).toBe("ready"));
}

beforeEach(() => {
  connect.mockReset();
  disconnectAll.mockReset();
  toastError.mockReset();
  getUserMedia.mockReset();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ token: "twilio-token" }) })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BrowserCallProvider.makeCall", () => {
  it("microphone blocked → tells the rep how to unblock it and never dials", async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    await renderReady();

    await act(() => ctx.makeCall(CALL));

    expect(connect).not.toHaveBeenCalled();
    expect(ctx.status).toBe("ready"); // never flipped to "connecting"
    expect(toastError).toHaveBeenCalledWith(
      "Microphone is blocked",
      expect.objectContaining({ description: expect.stringContaining("site settings") }),
    );
  });

  it("no microphone at all → says so and never dials", async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error("Requested device not found"), { name: "NotFoundError" }));
    await renderReady();

    await act(() => ctx.makeCall(CALL));

    expect(connect).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("No microphone found", expect.anything());
  });

  it("Twilio never answers → after 25s the call is dropped, state is ready, and the rep is told", async () => {
    const stop = vi.fn();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    connect.mockResolvedValue({ on: () => undefined, disconnect: vi.fn() }); // a call that never emits anything
    await renderReady();

    vi.useFakeTimers();
    await act(() => ctx.makeCall(CALL));
    expect(stop).toHaveBeenCalled(); // the permission probe released the mic
    expect(connect).toHaveBeenCalledTimes(1);
    expect(ctx.status).toBe("connecting");

    await act(() => vi.advanceTimersByTimeAsync(24_999));
    expect(ctx.status).toBe("connecting");
    expect(toastError).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(ctx.status).toBe("ready");
    expect(ctx.activeCall).toBeNull();
    expect(disconnectAll).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      "The call didn't go through",
      expect.objectContaining({ description: expect.stringContaining("25 seconds") }),
    );
  });

  // The rep gives up on "Connecting…" and hits Hang up. The watchdog was left
  // armed, so 25s later it fired an error toast about a call they had cancelled.
  it("hang up while connect() is still pending → the watchdog is disarmed, not fired later", async () => {
    getUserMedia.mockResolvedValue({ getTracks: () => [] });
    connect.mockReturnValue(new Promise(() => undefined)); // connect() never settles
    await renderReady();

    vi.useFakeTimers();
    void ctx.makeCall(CALL);
    await act(() => vi.advanceTimersByTimeAsync(1)); // let the mic probe resolve and connect() start
    expect(ctx.status).toBe("connecting");

    act(() => ctx.hangUp());
    expect(ctx.status).toBe("ready");
    expect(disconnectAll).toHaveBeenCalledTimes(1); // nothing left dialling behind the UI

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(toastError).not.toHaveBeenCalled();
    expect(ctx.status).toBe("ready");
  });

  it("the call is answered → the watchdog stands down", async () => {
    getUserMedia.mockResolvedValue({ getTracks: () => [] });
    const handlers: Record<string, () => void> = {};
    connect.mockResolvedValue({ on: (e: string, fn: () => void) => { handlers[e] = fn; }, disconnect: vi.fn() });
    await renderReady();

    vi.useFakeTimers();
    await act(() => ctx.makeCall(CALL));
    act(() => handlers.accept());
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(ctx.status).toBe("on-call");
    expect(disconnectAll).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
