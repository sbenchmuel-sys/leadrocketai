import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { Device, Call } from "@twilio/voice-sdk";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

// Token refresh hardening tunables
const MAX_REFRESH_ATTEMPTS = 4;
const SAFETY_REFRESH_MS = 50 * 60 * 1000; // proactively refresh well before the ~1h token TTL

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Periodic safety-refresh timer handle
  const safetyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against overlapping re-registration attempts (online + visibility + unregistered can all fire together)
  const reregisteringRef = useRef(false);
  // Tracks the single in-flight initDevice run. deviceRef is only set AFTER the async
  // register() resolves, so without this two near-simultaneous triggers (mount + SIGNED_IN
  // + a Call click) would each build a Device and overwrite the timer/listener/cleanup refs,
  // leaking the earlier device. Concurrent callers await this promise instead of being dropped.
  const initPromiseRef = useRef<Promise<void> | null>(null);
  // Ensures the "please refresh" toast is shown at most once per failure streak (reset on any success)
  const refreshFailedToastShownRef = useRef(false);
  // Removes the per-device timer + window listeners; set in initDevice, called on teardown
  const connectionCleanupRef = useRef<(() => void) | null>(null);
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

  const initDeviceRaw = useCallback(async () => {
    if (deviceRef.current) return;

    const token = await fetchToken();
    if (!token) return;

    setState((s) => ({ ...s, status: "registering" }));

    // Pre-create audio element for remote audio playback
    // This prevents "_onAddTrack" errors in iframe/embedded contexts
    if (!audioRef.current) {
      const audio = document.createElement("audio");
      audio.id = "twilio-remote-audio";
      audio.autoplay = true;
      // Required for autoplay policy in some browsers
      audio.setAttribute("playsinline", "");
      document.body.appendChild(audio);
      audioRef.current = audio;
    }

    const device = new Device(token, {
      edge: ["ashburn", "toronto", "umatilla"],
      closeProtection: true,
      maxCallSignalingTimeoutMs: 30000,
    });

    // Attach audio output to our pre-created element
    try {
      await device.audio?.speakerDevices.set("default");
    } catch {
      // setSinkId may not be supported — safe to ignore
    }

    // Refresh the token with exponential backoff, then push it into the live Device.
    // Returns true on success. Used by both tokenWillExpire and the safety timer.
    const refreshTokenWithRetry = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
        const token = await fetchToken();
        if (token) {
          try {
            device.updateToken(token);
            refreshFailedToastShownRef.current = false; // recovered — allow future alerts
            return true;
          } catch (e) {
            console.error("[BrowserCall] updateToken failed:", e);
          }
        }
        // Backoff before the next try (1s, 2s, 4s …, capped), skipping the wait after the last attempt
        if (attempt < MAX_REFRESH_ATTEMPTS - 1) {
          await sleep(Math.min(1000 * 2 ** attempt, 8000));
        }
      }
      // All attempts failed — surface a single, non-spammy prompt to reload
      if (!refreshFailedToastShownRef.current) {
        refreshFailedToastShownRef.current = true;
        toast.error("Call connection lost", {
          description: "We couldn't refresh your calling session. Please refresh the page to keep making calls.",
        });
      }
      return false;
    };

    // Re-register the Device if it has dropped out of the registered state.
    // Guarded so overlapping triggers (unregistered event + online + visibility) don't pile up.
    const reregisterDevice = async () => {
      if (reregisteringRef.current) return;
      if (deviceRef.current !== device) return; // stale closure after teardown
      const st = device.state;
      if (st === Device.State.Destroyed || st === Device.State.Registered || st === Device.State.Registering) return;
      reregisteringRef.current = true;
      try {
        setState((s) => (s.status === "ready" || s.status === "idle" ? { ...s, status: "registering" } : s));
        // Make sure the token is fresh before re-registering (a drop usually means it's stale/expired)
        await refreshTokenWithRetry();
        if (device.state !== Device.State.Destroyed) {
          await device.register();
        }
      } catch (e) {
        console.error("[BrowserCall] re-registration failed:", e);
      } finally {
        reregisteringRef.current = false;
      }
    };

    device.on("registered", () => {
      refreshFailedToastShownRef.current = false;
      setState((s) => ({ ...s, status: "ready" }));
    });

    // Device fell out of registration (network blip, server-side expiry) — recover automatically
    device.on("unregistered", () => {
      reregisterDevice();
    });

    device.on("error", (err) => {
      console.error("Twilio Device error:", err);
      const code = err?.code ?? (err as any)?.originalError?.code;
      let title = "Call device error";
      let desc = err.message;
      if (code === 31009) {
        title = "Network error";
        desc = "Cannot connect to call servers. If using the preview, try the published URL instead. Also check your firewall/VPN.";
      } else if (code === 31005) {
        title = "Connection error";
        desc = "Call signaling failed. Try refreshing the page or using the published URL.";
      }
      toast.error(title, { description: desc });
    });

    device.on("tokenWillExpire", () => {
      refreshTokenWithRetry();
    });

    // Periodic safety refresh independent of the tokenWillExpire event, in case that
    // event is missed (e.g. tab was backgrounded/asleep when it should have fired).
    safetyTimerRef.current = setInterval(() => {
      refreshTokenWithRetry();
    }, SAFETY_REFRESH_MS);

    // Recover when the browser regains connectivity or the tab becomes visible again
    const handleOnline = () => reregisterDevice();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") reregisterDevice();
    };
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    connectionCleanupRef.current = () => {
      if (safetyTimerRef.current != null) {
        clearInterval(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      connectionCleanupRef.current = null;
    };

    try {
      await device.register();
    } catch (e) {
      // Registration failed — tear down the partial device, safety timer, and window
      // listeners so a later retry starts clean instead of overwriting (and leaking) them.
      console.error("[BrowserCall] device registration failed:", e);
      connectionCleanupRef.current?.();
      try { device.destroy(); } catch { /* ignore */ }
      return;
    }
    deviceRef.current = device;
  }, [fetchToken]);

  // Concurrency wrapper: collapse overlapping initDevice() triggers (mount + SIGNED_IN +
  // a Call click) onto ONE in-flight init, and let concurrent callers (e.g. makeCall)
  // await that same init instead of being dropped while deviceRef is still null.
  const initDevice = useCallback(async () => {
    if (deviceRef.current) return;
    if (initPromiseRef.current) { await initPromiseRef.current; return; }
    const p = initDeviceRaw();
    initPromiseRef.current = p;
    try { await p; } finally { initPromiseRef.current = null; }
  }, [initDeviceRaw]);

  // Initialize device on mount if user is authenticated
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) initDevice();
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") initDevice();
      if (event === "SIGNED_OUT") {
        connectionCleanupRef.current?.();
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
      connectionCleanupRef.current?.();
      deviceRef.current?.destroy();
      deviceRef.current = null;
      if (audioRef.current) {
        audioRef.current.remove();
        audioRef.current = null;
      }
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
      // === DIAGNOSTIC: Log pre-connect state ===
      console.log("[BrowserCall] PRE-CONNECT", {
        deviceState: deviceRef.current.state,
        to: toNormalized,
        fromNumber: fromNormalized,
        leadId: opts.leadId,
        identity: deviceRef.current.identity,
      });

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
        } else if (code === 21215 || code === 21214) {
          title = "Geo-permission blocked";
          desc = "Your Twilio account does not have permission to call this region. Enable it in Twilio Console → Voice → Geo Permissions.";
        } else if (code === 13227 || code === 13224) {
          title = "Number not verified";
          desc = "Your Twilio account requires a verified Business Profile to call this number. Complete your profile at twilio.com/console.";
        } else if (code === 20101) {
          title = "Authentication expired";
          desc = "Your call session expired. Please refresh the page and try again.";
        }
        toast.error(title, { description: desc });
        setState((s) => ({ ...s, status: "ready", activeCall: null, leadId: null, leadName: null, fromNumber: null, toNumber: null, isMuted: false, startedAt: null }));
      });

      // Set connecting state with call reference
      setState((s) => ({ ...s, activeCall: call }));
    } catch (err: any) {
      toast.error("Failed to connect call", { description: err.message });
      setState((s) => ({ ...s, status: "ready" }));
    }
  }, [initDevice]);

  const hangUp = useCallback(() => {
    if (state.activeCall) {
      state.activeCall.disconnect();
    } else {
      // Force reset if call object is already gone (e.g. after error)
      setState((s) => ({ ...s, status: "ready", activeCall: null, leadId: null, leadName: null, fromNumber: null, toNumber: null, isMuted: false, startedAt: null }));
    }
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
