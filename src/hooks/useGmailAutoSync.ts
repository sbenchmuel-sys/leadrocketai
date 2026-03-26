import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useGmailConnection } from "./useGmailConnection";

const BULK_SYNC_BATCH_SIZE = 15;

interface LeadToSync {
  id: string;
  email: string;
}

/**
 * Gmail auto-sync hook — MANUAL TRIGGER ONLY.
 *
 * The primary recurring sync is handled server-side by pg_cron
 * (cron-dispatcher → gmail-bulk-sync every 20 min). This hook
 * exposes a manual `runBulkSync` for the UI "Sync now" button.
 */
export function useGmailAutoSync() {
  const { isConnected } = useGmailConnection();

  const runBulkSync = useCallback(async () => {
    if (!isConnected) return;

    try {
      const { data: leads, error: leadsError } = await supabase
        .from("leads")
        .select("id, email")
        .not("email", "is", null);

      if (leadsError || !leads || leads.length === 0) {
        console.log("[GmailSync] No leads to sync or error:", leadsError?.message);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        console.log("[GmailSync] No auth token, skipping");
        return;
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const leadIds = leads.map((l: LeadToSync) => l.id);
      let totalSynced = 0;

      for (let i = 0; i < leadIds.length; i += BULK_SYNC_BATCH_SIZE) {
        const batchIds = leadIds.slice(i, i + BULK_SYNC_BATCH_SIZE);

        const response = await fetch(`${supabaseUrl}/functions/v1/gmail-bulk-sync`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            leadIds: batchIds,
            maxResults: 10,
          }),
        });

        const rawBody = await response.text();
        const result = rawBody ? JSON.parse(rawBody) : {};

        if (result.needsReconnect) {
          console.warn("[GmailSync] Gmail needs reconnection");
          return;
        }

        if (!response.ok || !result.ok) {
          console.error("[GmailSync] Bulk sync batch failed:", response.status, result.error);
          continue;
        }

        totalSynced += Number(result.totalSynced ?? 0);
      }

      if (totalSynced > 0) {
        console.log(`[GmailSync] Manual sync: ${totalSynced} emails synced`);
      }
    } catch (err) {
      console.error("[GmailSync] Error:", err);
    }
  }, [isConnected]);

  return { runBulkSync };
}
