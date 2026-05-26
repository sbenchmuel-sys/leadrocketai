// ============================================================
// useRealtimeSubscription — thin wrapper over Supabase Realtime
//
// Subscribes to postgres_changes for a given table + optional
// row filter and invokes a callback on any matching event. The
// channel is torn down on unmount or when the inputs change.
// Pass `enabled: false` to skip subscribing (e.g. workspace not
// loaded yet).
// ============================================================

import { useEffect, useRef } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type ChangeEvent = "INSERT" | "UPDATE" | "DELETE" | "*";

interface UseRealtimeSubscriptionOptions {
  table: string;
  /** PostgREST-style row filter, e.g. "workspace_id=eq.abc". Omit for all rows. */
  filter?: string;
  /** Which change types to listen to. Defaults to all events. */
  event?: ChangeEvent;
  /** Disable the subscription entirely (e.g. while data isn't ready). */
  enabled?: boolean;
  /** Optional channel name override — useful if you need multiple subscriptions
   *  on the same table within a single page and want to avoid collision. */
  channelName?: string;
}

export function useRealtimeSubscription(
  opts: UseRealtimeSubscriptionOptions,
  onChange: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void
) {
  const { table, filter, event = "*", enabled = true, channelName } = opts;

  // Keep the latest callback in a ref so we don't rebuild the channel on every render.
  const callbackRef = useRef(onChange);
  callbackRef.current = onChange;

  useEffect(() => {
    if (!enabled) return;

    const name = channelName ?? `rt-${table}-${filter ?? "all"}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(name)
      .on(
        // @ts-expect-error — supabase-js typings for postgres_changes are too strict
        "postgres_changes",
        {
          event,
          schema: "public",
          table,
          ...(filter ? { filter } : {}),
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          callbackRef.current(payload);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [table, filter, event, enabled, channelName]);
}
