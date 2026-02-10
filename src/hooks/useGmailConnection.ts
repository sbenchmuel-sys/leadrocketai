import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type GmailAuthFallback = { authUrl: string } | null;

export interface GmailConnection {
  id: string;
  user_id: string;
  gmail_email: string;
  token_expires_at: string;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export function useGmailConnection() {
  const [connection, setConnection] = useState<GmailConnection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authFallback, setAuthFallback] = useState<GmailAuthFallback>(null);

  const fetchConnection = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setConnection(null);
        return;
      }

      const { data, error: fetchError } = await supabase
        .from("gmail_connections")
        .select("id, user_id, gmail_email, token_expires_at, last_sync_at, created_at, updated_at")
        .eq("user_id", user.id)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      setConnection(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch Gmail connection");
      setConnection(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnection();
  }, [fetchConnection]);

  // Detect ?gmail_connected=true after redirect back from OAuth
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail_connected") === "true") {
      // Clean up the query param
      params.delete("gmail_connected");
      const newSearch = params.toString();
      const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
      window.history.replaceState({}, "", newUrl);

      toast.success("Gmail connected!", { description: "Your Gmail account has been linked successfully." });
      fetchConnection();
    }
  }, [fetchConnection]);

  const connectGmail = async (returnUrl?: string) => {
    try {
      setError(null);
      setIsConnecting(true);
      setAuthFallback(null);

      const path = returnUrl || window.location.pathname;

      const { data, error: fnError } = await supabase.functions.invoke("gmail-auth", {
        body: { redirectUrl: window.location.href, returnUrl: path },
      });

      if (fnError) {
        throw new Error(fnError.message);
      }

      if (!data.ok) {
        throw new Error(data.error || "Failed to start OAuth");
      }

      // Try navigating: top window first, then current window, then fallback to link
      try {
        if (window.top && window.top !== window) {
          window.top.location.href = data.authUrl;
          return;
        }
      } catch {
        // Cross-origin iframe, can't access top
      }

      try {
        window.location.href = data.authUrl;
        return;
      } catch {
        // Navigation blocked
      }

      // Fallback: show the URL for manual opening
      setIsConnecting(false);
      setAuthFallback({ authUrl: data.authUrl });
    } catch (err) {
      setIsConnecting(false);
      setError(err instanceof Error ? err.message : "Failed to start Gmail connection");
      throw err;
    }
  };

  const clearAuthFallback = () => setAuthFallback(null);

  const disconnect = async () => {
    try {
      setError(null);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not logged in");

      const { error: deleteError } = await supabase
        .from("gmail_connections")
        .delete()
        .eq("user_id", user.id);

      if (deleteError) {
        throw deleteError;
      }

      setConnection(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect Gmail");
      throw err;
    }
  };

  return {
    connection,
    isConnected: !!connection,
    isLoading,
    isConnecting,
    error,
    authFallback,
    connectGmail,
    clearAuthFallback,
    disconnect,
    refetch: fetchConnection,
  };
}
