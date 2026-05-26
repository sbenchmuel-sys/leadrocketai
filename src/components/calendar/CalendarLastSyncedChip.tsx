// ============================================================
// CalendarLastSyncedChip — "Calendar synced X ago" pill
//
// Shows the freshness of the workspace's calendar pull. Uses
// MAX(calendar_events.updated_at) as the signal — that's the most
// recent moment the calendar-sync cron actually touched a row.
// Subscribes to realtime updates so the timestamp moves live.
// ============================================================

import { useEffect, useState, useCallback } from "react";
import { Calendar, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { cn } from "@/lib/utils";

interface CalendarLastSyncedChipProps {
  className?: string;
  /** Optional click handler — typically caller passes a "refresh meetings" callback. */
  onRefresh?: () => void | Promise<void>;
  isRefreshing?: boolean;
}

export function CalendarLastSyncedChip({
  className,
  onRefresh,
  isRefreshing = false,
}: CalendarLastSyncedChipProps) {
  const { workspaceId } = useWorkspace();
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const fetchLastSync = useCallback(async () => {
    if (!workspaceId) return;
    const { data } = await supabase
      .from("calendar_events")
      .select("updated_at")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setLastSyncAt(data?.updated_at ?? null);
  }, [workspaceId]);

  useEffect(() => {
    fetchLastSync();
  }, [fetchLastSync]);

  // Keep the relative-time label honest as time passes.
  useEffect(() => {
    if (!lastSyncAt) return;
    const interval = setInterval(() => setLastSyncAt(prev => prev), 60_000);
    return () => clearInterval(interval);
  }, [lastSyncAt]);

  // Live-update when calendar-sync writes a new row.
  useRealtimeSubscription(
    {
      table: "calendar_events",
      filter: workspaceId ? `workspace_id=eq.${workspaceId}` : undefined,
      enabled: !!workspaceId,
    },
    () => {
      fetchLastSync();
    }
  );

  const label = lastSyncAt
    ? `Calendar synced ${formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true })}`
    : "Calendar not synced yet";

  const content = (
    <>
      {isRefreshing ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Calendar className="h-3 w-3" />
      )}
      <span>{label}</span>
    </>
  );

  if (onRefresh) {
    return (
      <button
        type="button"
        onClick={onRefresh}
        disabled={isRefreshing}
        className={cn(
          "inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60",
          className
        )}
        title="Calendar pulls every 15 minutes via cron"
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
      title="Calendar pulls every 15 minutes via cron"
    >
      {content}
    </span>
  );
}
