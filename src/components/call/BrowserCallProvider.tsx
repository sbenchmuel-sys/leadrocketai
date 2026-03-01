import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { Device, Call } from "@twilio/voice-sdk";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

interface BrowserCallState {
  status: "idle" | "registering" | "ready" | "connecting" | "on-call";
  activeCall: Call | null;
  leadId: string | null;
  leadName: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  isMuted: boolean;
  startedAt: Date | null;
}

interface BrowserCallContextValue extends BrowserCallState {
  makeCall: (opts: { toNumber: string; fromNumber: string; leadId: string; leadName: string }) => Promise<void>;
  hangUp: () => void;
  toggleMute: () => void;
}

const BrowserCallContext = createContext<BrowserCallContextValue | null>(null);

export function useBrowserCall() {
  const ctx = useContext(BrowserCallContext);
  if (!ctx) throw new Error("useBrowserCall must be used within BrowserCallProvider");
  return ctx;
}

export function BrowserCallProvider({ children }: { children: ReactNode }) {
  const deviceRef = useRef<Device | null>(null);
  const [state, setState] = useState<BrowserCallState>({
    status: "idle",
    activeCall: null,
    leadId: null,
    leadName: null,
    fromNumber: null,
    toNumber: null,
    isMuted: false,
    startedAt: null,
  });

  const fetchToken = useCallback(async (): Promise<string | null> => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return null;

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/twilio-voice-token`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
      });

      if (!resp.ok) return null;
      const body = await resp.json();
      return body.token ?? null;
    } catch {
      return null;
    }
  }, []);

  const initDevice = useCallback(async () => {
    if (deviceRef.current) return;

    const token = await fetchToken();
    if (!token) return;

    setState((s) => ({ ...s, status: "registering" }));

    const device = new Device(token, {
      edge: "ashburn",
      closeProtection: true,
    });

    device.on("registered", () => {
      setState((s) => ({ ...s, status: "ready" }));
    });

    device.on("error", (err) => {
      console.error("Twilio Device error:", err);
      toast.error("Call device error", { description: err.message });
    });

    device.on("tokenWillExpire", async () => {
      const newToken = await fetchToken();
      if (newToken) device.updateToken(newToken);
    });

    await device.register();
    deviceRef.current = device;
  }, [fetchToken]);

  // Initialize device on mount if user is authenticated
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) initDevice();
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") initDevice();
      if (event === "SIGNED_OUT") {
        deviceRef.current?.destroy();
        deviceRef.current = null;
        setState({
          status: "idle",
          activeCall: null,
          leadId: null,
          leadName: null,
          fromNumber: null,
          toNumber: null,
          isMuted: false,
          startedAt: null,
        });
      }
    });

    return () => {
      subscription.unsubscribe();
      deviceRef.current?.destroy();
      deviceRef.current = null;
    };
  }, [initDevice]);

  const makeCall = useCallback(async (opts: { toNumber: string; fromNumber: string; leadId: string; leadName: string }) => {
    // Normalize to E.164 before dialing
    function normalizeToE164(number: string): string {
      const cleaned = number.replace(/[^\d+]/g, "");
      if (!cleaned.startsWith("+")) {
        throw new Error("Phone number must be in E.164 format (start with +)");
      }
      return cleaned;
    }

    let toNormalized: string;
    let fromNormalized: string;
    try {
      toNormalized = normalizeToE164(opts.toNumber);
      fromNormalized = normalizeToE164(opts.fromNumber);
    } catch (err: any) {
      toast.error("Invalid phone number", { description: err.message });
      return;
    }

    if (!deviceRef.current) {
      await initDevice();
    }
    if (!deviceRef.current) {
      toast.error("Call device not ready");
      return;
    }

    setState((s) => ({
      ...s,
      status: "connecting",
      leadId: opts.leadId,
      leadName: opts.leadName,
      fromNumber: fromNormalized,
      toNumber: toNormalized,
      isMuted: false,
      startedAt: null,
    }));

    try {
      const call = await deviceRef.current.connect({
        params: {
          To: toNormalized,
          FromNumber: fromNormalized,
          LeadId: opts.leadId,
        },
      });

      call.on("accept", () => {
        setState((s) => ({ ...s, status: "on-call", activeCall: call, startedAt: new Date() }));
      });

      call.on("disconnect", () => {
        setState((s) => ({
          ...s,
          status: "ready",
          activeCall: null,
          leadId: null,
          leadName: null,
          fromNumber: null,
          toNumber: null,
          isMuted: false,
          startedAt: null,
        }));
      });

      call.on("cancel", () => {
        setState((s) => ({
          ...s,
          status: "ready",
          activeCall: null,
          leadId: null,
          leadName: null,
          isMuted: false,
          startedAt: null,
        }));
      });

      call.on("error", (err: any) => {
        console.error("Call error:", err);
        const code = err?.originalError?.code ?? err?.code;
        let title = "Call failed";
        let desc = err.message;
        if (code === 31603) {
          title = "Call declined";
          desc = "The recipient declined or didn't answer the call.";
        } else if (code === 31005) {
          title = "Connection error";
          desc = "Could not connect the call. The recipient may have declined.";
        } else if (code === 31009) {
          title = "Network error";
          desc = "Check your internet connection and try again.";
        }
        toast.error(title, { description: desc });
        setState((s) => ({ ...s, status: "ready", activeCall: null }));
      });

      // Set connecting state with call reference
      setState((s) => ({ ...s, activeCall: call }));
    } catch (err: any) {
      toast.error("Failed to connect call", { description: err.message });
      setState((s) => ({ ...s, status: "ready" }));
    }
  }, [initDevice]);

  const hangUp = useCallback(() => {
    state.activeCall?.disconnect();
  }, [state.activeCall]);

  const toggleMute = useCallback(() => {
    if (!state.activeCall) return;
    const newMuted = !state.isMuted;
    state.activeCall.mute(newMuted);
    setState((s) => ({ ...s, isMuted: newMuted }));
  }, [state.activeCall, state.isMuted]);

  return (
    <BrowserCallContext.Provider value={{ ...state, makeCall, hangUp, toggleMute }}>
      {children}
    </BrowserCallContext.Provider>
  );
}
