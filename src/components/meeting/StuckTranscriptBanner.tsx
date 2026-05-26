// ============================================================
// StuckTranscriptBanner — amber row for transcripts stuck >24h
//
// Surfaces meeting_transcripts rows that have been in 'fetching' or
// 'pending' status for more than 24h. Without this, the rows sit
// silently while the rest of the timeline keeps moving.
//
// The "Retry" CTA resets the row's poller state — clears
// fetch_attempts (drops the backoff window) and flips status back
// to 'pending'. The next transcript-poller tick (≤15 min) then
// dispatches the right provider-specific fetcher with proper
// internal auth.
//
// Why not call meet-transcript-fetch / teams-transcript-fetch
// directly? They require X-Internal-Secret (privileged caller)
// and accept {calendarEventId}, not {meeting_transcript_id} —
// so the frontend can't invoke them safely. Going through the
// poller keeps the auth boundary intact.
//
// Caveat: transcript-poller only scans meetings whose end_time
// is within the last 24h. For transcripts on older meetings, the
// reset will leave the row eligible but the poller window won't
// include it. We disclose this in the toast.
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
  calendar_event_id: string;
}

const STUCK_AGE_MS = 24 * 60 * 60 * 1000;
const POLLER_WINDOW_MS = 24 * 60 * 60 * 1000;

export function StuckTranscriptBanner({ leadId }: StuckTranscriptBannerProps) {
  const [rows, setRows] = useState<StuckTranscript[]>([]);
  const [eventEndById, setEventEndById] = useState<Map<string, string | null>>(new Map());
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const fetchStuck = useCallback(async () => {
    if (!leadId) return;
    const cutoff = new Date(Date.now() - STUCK_AGE_MS).toISOString();
    const { data } = await supabase
      .from("meeting_transcripts")
      .select("id, provider, status, fetch_attempts, last_attempt_at, provider_error_detail, status_reason, calendar_event_id")
      .eq("lead_id", leadId)
      .in("status", ["fetching", "pending"])
      .lt("last_attempt_at", cutoff);
    const stuck = (data ?? []) as StuckTranscript[];
    setRows(stuck);

    // Look up end_time for each underlying calendar event so the toast can
    // tell the user honestly whether the poller will actually re-pick the
    // row up (its window is 24h from end_time).
    const eventIds = [...new Set(stuck.map(r => r.calendar_event_id).filter(Boolean))];
    if (eventIds.length === 0) {
      setEventEndById(new Map());
      return;
    }
    const { data: events } = await supabase
      .from("calendar_events")
      .select("id, end_time")
      .in("id", eventIds);
    const map = new Map<string, string | null>();
    for (const ev of (events ?? []) as Array<{ id: string; end_time: string | null }>) {
      map.set(ev.id, ev.end_time);
    }
    setEventEndById(map);
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

  // Reset the row so transcript-poller will pick it up on its next 15-min
  // tick. We can't call meet-transcript-fetch / teams-transcript-fetch
  // directly — those are internal-only and expect calendarEventId.
  const handleRetry = async (row: StuckTranscript) => {
    setRetryingId(row.id);
    try {
      const { error } = await supabase
        .from("meeting_transcripts")
        .update({
          status: "pending",
          fetch_attempts: 0,
          last_attempt_at: null,
          provider_error_detail: null,
          status_reason: null,
        })
        .eq("id", row.id);
      if (error) throw new Error(error.message);

      // Honest signal to the user: the poller only scans meetings whose
      // end_time is within the last 24h. Older meetings won't be picked
      // up even after this reset — the reset just unblocks them if a
      // future backfill widens the window.
      const endTime = eventEndById.get(row.calendar_event_id) ?? null;
      const endMs = endTime ? new Date(endTime).getTime() : null;
      const outsidePollerWindow = endMs === null || (Date.now() - endMs) > POLLER_WINDOW_MS;

      if (outsidePollerWindow) {
        toast.warning("Retry reset — meeting is outside the 15-min poller window", {
          description: "Row marked pending, but the meeting ended >24h ago so transcript-poller won't auto-pick it up. Contact support to backfill.",
        });
      } else {
        toast.success("Retry queued", {
          description: "transcript-poller will pick it up within 15 minutes",
        });
      }
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
        // meeting_transcripts.provider uses 'microsoft_teams' / 'google_meet'.
        const providerLabel = row.provider === "microsoft_teams" ? "Teams" : "Google Meet";
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
