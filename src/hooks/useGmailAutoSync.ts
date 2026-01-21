import { useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useGmailConnection } from "./useGmailConnection";

const AUTO_SYNC_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

interface LeadToSync {
  id: string;
  email: string;
}

export function useGmailAutoSync() {
  const { isConnected, isLoading } = useGmailConnection();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isSyncingRef = useRef(false);

  const runBulkSync = useCallback(async () => {
    // Skip if already syncing or not connected
    if (isSyncingRef.current || !isConnected) return;

    try {
      isSyncingRef.current = true;

      // Get the user's leads that have email addresses
      const { data: leads, error: leadsError } = await supabase
        .from("leads")
        .select("id, email")
        .not("email", "is", null);

      if (leadsError || !leads || leads.length === 0) {
        console.log("[AutoSync] No leads to sync or error:", leadsError?.message);
        return;
      }

      // Get auth token
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        console.log("[AutoSync] No auth token, skipping");
        return;
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

      // Call bulk sync endpoint with leadIds array
      const response = await fetch(`${supabaseUrl}/functions/v1/gmail-bulk-sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          leadIds: leads.map((l: LeadToSync) => l.id),
          maxResults: 10,
        }),
      });

      if (!response.ok) {
        console.error("[AutoSync] Bulk sync failed:", response.status);
        return;
      }

      const result = await response.json();
      if (result.ok && result.totalSynced > 0) {
        console.log(`[AutoSync] Synced ${result.totalSynced} emails across ${result.leadsProcessed} leads`);
      }
    } catch (err) {
      console.error("[AutoSync] Error:", err);
    } finally {
      isSyncingRef.current = false;
    }
  }, [isConnected]);

  useEffect(() => {
    // Don't start until we know connection status
    if (isLoading) return;

    // Only run if Gmail is connected
    if (!isConnected) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Run immediately on mount/connection
    runBulkSync();

    // Set up interval for periodic sync
    intervalRef.current = setInterval(runBulkSync, AUTO_SYNC_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isConnected, isLoading, runBulkSync]);

  return { runBulkSync };
}
