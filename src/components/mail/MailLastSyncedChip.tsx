// ============================================================
// MailLastSyncedChip — "synced X ago · refresh" pill
//
// Reads last_sync_at from the workspace's default mail_accounts row
// and renders a click-to-refresh chip. Caller supplies the refresh
// behavior (sync a lead, re-fetch a list, etc).
// ============================================================

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { cn } from "@/lib/utils";

interface MailLastSyncedChipProps {
  onRefresh: () => void | Promise<void>;
  isRefreshing?: boolean;
  /** Optional label prefix, e.g. "Timeline · " or "Inbox · ". */
  prefix?: string;
  className?: string;
}

export function MailLastSyncedChip({
  onRefresh,
  isRefreshing = false,
  prefix,
  className,
}: MailLastSyncedChipProps) {
  const { workspaceId } = useWorkspace();
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const fetchLastSync = useCallback(async () => {
    if (!workspaceId) return;
    const { data } = await supabase
      .from("mail_accounts")
      .select("last_sync_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "connected")
      .order("is_default", { ascending: false })
      .order("last_sync_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    setLastSyncAt(data?.last_sync_at ?? null);
  }, [workspaceId]);

  useEffect(() => {
    fetchLastSync();
  }, [fetchLastSync]);

  // Refresh the timestamp once a minute so the "X ago" stays honest
  // without the caller having to remount the chip.
  useEffect(() => {
    if (!lastSyncAt) return;
    const interval = setInterval(() => {
      // force re-render — date-fns will recompute on read
      setLastSyncAt(prev => (prev ? prev : prev));
    }, 60_000);
    return () => clearInterval(interval);
  }, [lastSyncAt]);

  // Re-fetch the timestamp when the parent's refresh completes
  useEffect(() => {
    if (!isRefreshing) {
      fetchLastSync();
    }
  }, [isRefreshing, fetchLastSync]);

  const label = lastSyncAt
    ? `${prefix ?? ""}synced ${formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true })}`
    : `${prefix ?? ""}never synced`;

  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={isRefreshing}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60",
        className
      )}
      title="Click to sync now"
    >
      {isRefreshing ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <RefreshCw className="h-3 w-3" />
      )}
      <span>{label}</span>
    </button>
  );
}
