// ============================================================
// StuckTranscriptBanner — amber row for transcripts stuck >24h
//
// Surfaces meeting_transcripts rows that have been in 'fetching' or
// 'pending' status for more than 24h. Without this, the rows sit
// silently while the rest of the timeline keeps moving. Provides a
// one-click "Retry" that re-invokes the provider-specific fetcher
// (meet-transcript-fetch / teams-transcript-fetch) for that row.
//
// transcript-poller already runs every 15 min, but it backs off on
// repeated failures — this UI gives the user an explicit recovery
// path when the automatic retry stops trying.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { toast } from "sonner";

interface StuckTranscriptBannerProps {
  leadId: string;
}

interface StuckTranscript {
  id: string;
  provider: string;
  status: string;
  fetch_attempts: number;
  last_attempt_at: string | null;
  provider_error_detail: string | null;
  status_reason: string | null;
}

const STUCK_AGE_MS = 24 * 60 * 60 * 1000;

export function StuckTranscriptBanner({ leadId }: StuckTranscriptBannerProps) {
  const [rows, setRows] = useState<StuckTranscript[]>([]);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const fetchStuck = useCallback(async () => {
    if (!leadId) return;
    const cutoff = new Date(Date.now() - STUCK_AGE_MS).toISOString();
    const { data } = await supabase
      .from("meeting_transcripts")
      .select("id, provider, status, fetch_attempts, last_attempt_at, provider_error_detail, status_reason")
      .eq("lead_id", leadId)
      .in("status", ["fetching", "pending"])
      .lt("last_attempt_at", cutoff);
    setRows((data ?? []) as StuckTranscript[]);
  }, [leadId]);

  useEffect(() => {
    fetchStuck();
  }, [fetchStuck]);

  useRealtimeSubscription(
    {
      table: "meeting_transcripts",
      filter: `lead_id=eq.${leadId}`,
      enabled: !!leadId,
    },
    () => {
      fetchStuck();
    }
  );

  const handleRetry = async (row: StuckTranscript) => {
    setRetryingId(row.id);
    try {
      const fn = row.provider === "teams" ? "teams-transcript-fetch" : "meet-transcript-fetch";
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        toast.error("Not authenticated");
        return;
      }
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const resp = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ meeting_transcript_id: row.id, force: true }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text.slice(0, 200));
      }
      toast.success("Retry queued — transcript fetcher restarted");
      fetchStuck();
    } catch (err) {
      toast.error("Retry failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRetryingId(null);
    }
  };

  if (rows.length === 0) return null;

  return (
    <div className="space-y-2">
      {rows.map(row => {
        const ageHours = row.last_attempt_at
          ? Math.round((Date.now() - new Date(row.last_attempt_at).getTime()) / (60 * 60 * 1000))
          : null;
        const providerLabel = row.provider === "teams" ? "Teams" : "Google Meet";
        return (
          <div
            key={row.id}
            className="flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:bg-amber-900/20 dark:border-amber-800/50"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-amber-900 dark:text-amber-100">
                {providerLabel} transcript stuck
              </div>
              <div className="text-amber-800/80 dark:text-amber-200/80 truncate">
                {row.fetch_attempts} attempt{row.fetch_attempts === 1 ? "" : "s"}
                {ageHours !== null && ` · last try ${ageHours}h ago`}
                {row.provider_error_detail && ` · ${row.provider_error_detail.slice(0, 80)}`}
                {!row.provider_error_detail && row.status_reason && ` · ${row.status_reason.slice(0, 80)}`}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleRetry(row)}
              disabled={retryingId === row.id}
              className="h-7 text-xs"
            >
              {retryingId === row.id ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Retry
            </Button>
          </div>
        );
      })}
    </div>
  );
}
