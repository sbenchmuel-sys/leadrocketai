import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

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
  const [error, setError] = useState<string | null>(null);

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

  const startOAuth = async (redirectUrl?: string) => {
    try {
      setError(null);
      const { data, error: fnError } = await supabase.functions.invoke("gmail-auth", {
        body: { redirectUrl: redirectUrl || window.location.href },
      });

      if (fnError) {
        throw new Error(fnError.message);
      }

      if (!data.ok) {
        throw new Error(data.error || "Failed to start OAuth");
      }

      // Redirect to Google's OAuth flow.
      // In the Lovable preview the app runs inside an iframe, so we must redirect the top window.
      const target = window.top ?? window;
      target.location.href = data.authUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Gmail OAuth");
      throw err;
    }
  };

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
    error,
    startOAuth,
    disconnect,
    refetch: fetchConnection,
  };
}
