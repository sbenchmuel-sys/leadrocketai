// ============================================================
// DraftCacheInvalidator — clear 5-min draft cache on new inbound
//
// Mounted once in DashboardLayout. Subscribes to workspace-wide
// `lead_timeline_items` inserts and clears the in-memory draft
// cache for any lead that just received inbound activity.
//
// Why: the 5-min draft cache in src/lib/generateDraft.ts can mask
// a freshly-arrived reply. Without this, a user opening DraftsTab
// within 5 minutes of an inbound would see a draft that doesn't
// know about the new email.
//
// We deliberately do NOT auto-regenerate here — only invalidate.
// That keeps cost bounded (no AI spend on leads no one views).
// The next time the user opens the lead, a cache miss triggers
// fresh generation on demand.
// ============================================================

import { useCallback } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { clearDraftCache } from "@/lib/generateDraft";

export function DraftCacheInvalidator() {
  const { workspaceId } = useWorkspace();

  const onChange = useCallback((payload: { new?: Record<string, unknown> }) => {
    const row = payload.new;
    if (!row) return;
    const eventType = typeof row.event_type === "string" ? row.event_type : "";
    const leadId = typeof row.lead_id === "string" ? row.lead_id : "";
    if (eventType !== "email_inbound" || !leadId) return;
    clearDraftCache(leadId);
  }, []);

  useRealtimeSubscription(
    {
      table: "lead_timeline_items",
      filter: workspaceId ? `workspace_id=eq.${workspaceId}` : undefined,
      enabled: !!workspaceId,
      event: "INSERT",
      channelName: workspaceId ? `draft-cache-invalidator-${workspaceId}` : undefined,
    },
    onChange
  );

  return null;
}
