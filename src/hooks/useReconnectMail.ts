// ============================================================
// useReconnectMail — shared one-click reconnect for Gmail / Outlook
//
// Lets banners, inline chips, and Settings cards trigger the OAuth
// flow without each surface re-implementing the auth init dance.
// ============================================================

import { useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type MailProviderName = "gmail" | "outlook";

export interface ReconnectAuthFallback {
  provider: MailProviderName;
  authUrl: string;
}

interface ReconnectGmailArgs {
  returnUrl?: string;
}

interface ReconnectOutlookArgs {
  workspaceId: string;
  onComplete?: () => void;
}

export function useReconnectMail() {
  const [isConnecting, setIsConnecting] = useState(false);
  const [authFallback, setAuthFallback] = useState<ReconnectAuthFallback | null>(null);

  const clearAuthFallback = useCallback(() => setAuthFallback(null), []);

  const reconnectGmail = useCallback(async (args: ReconnectGmailArgs = {}) => {
    try {
      setIsConnecting(true);
      setAuthFallback(null);

      const returnUrl = args.returnUrl ?? window.location.pathname;

      const { data, error } = await supabase.functions.invoke("gmail-auth", {
        body: { redirectUrl: window.location.href, returnUrl },
      });

      if (error) throw new Error(error.message);
      if (!data?.ok || !data?.authUrl) {
        throw new Error(data?.error || "Failed to start Gmail OAuth");
      }

      try {
        if (window.top && window.top !== window) {
          window.top.location.href = data.authUrl;
          return;
        }
      } catch {
        // cross-origin iframe — fall through
      }

      try {
        window.location.href = data.authUrl;
        return;
      } catch {
        // navigation blocked — fall through to manual link
      }

      setIsConnecting(false);
      setAuthFallback({ provider: "gmail", authUrl: data.authUrl });
    } catch (err) {
      setIsConnecting(false);
      const message = err instanceof Error ? err.message : "Failed to start Gmail reconnect";
      toast.error("Reconnect failed", { description: message });
      throw err;
    }
  }, []);

  const reconnectOutlook = useCallback(async (args: ReconnectOutlookArgs) => {
    try {
      setIsConnecting(true);
      setAuthFallback(null);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("Not authenticated");

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const resp = await fetch(`${supabaseUrl}/functions/v1/outlook-auth`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId: args.workspaceId }),
      });

      const data = await resp.json().catch(() => ({ ok: false, error: "Invalid response" }));

      if (data?.not_configured) {
        throw new Error("Outlook integration not fully configured. Please contact your administrator.");
      }
      if (!resp.ok || !data?.ok || !data?.authUrl) {
        throw new Error(data?.error || `Request failed (${resp.status})`);
      }

      const popup = window.open(
        data.authUrl,
        "outlook_oauth",
        "width=520,height=650,left=200,top=100"
      );

      if (!popup) {
        // Popup blocked — fall back to full-tab navigation
        window.location.href = data.authUrl;
        return;
      }

      const poll = setInterval(() => {
        if (popup.closed) {
          clearInterval(poll);
          setIsConnecting(false);
          args.onComplete?.();
        }
      }, 800);
    } catch (err) {
      setIsConnecting(false);
      const message = err instanceof Error ? err.message : "Failed to start Outlook reconnect";
      toast.error("Reconnect failed", { description: message });
      throw err;
    }
  }, []);

  /**
   * Unified entry point — picks the right OAuth flow based on provider.
   * Outlook requires `workspaceId`; Gmail uses the caller's user.
   */
  const reconnect = useCallback(
    async (
      provider: MailProviderName,
      opts: { returnUrl?: string; workspaceId?: string; onComplete?: () => void } = {}
    ) => {
      if (provider === "outlook") {
        if (!opts.workspaceId) {
          throw new Error("workspaceId required to reconnect Outlook");
        }
        return reconnectOutlook({ workspaceId: opts.workspaceId, onComplete: opts.onComplete });
      }
      return reconnectGmail({ returnUrl: opts.returnUrl });
    },
    [reconnectGmail, reconnectOutlook]
  );

  return {
    reconnect,
    reconnectGmail,
    reconnectOutlook,
    isConnecting,
    authFallback,
    clearAuthFallback,
  };
}
