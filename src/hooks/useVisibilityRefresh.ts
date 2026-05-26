// ============================================================
// useVisibilityRefresh — refetch when the user returns to the tab
//
// Calls `onRefresh` whenever the tab regains visibility (or window
// regains focus) AND it's been at least `minIntervalMs` since the
// last call. Mirrors the pausing pattern of useAutomationPoller —
// no work happens while the tab is hidden.
// ============================================================

import { useCallback, useEffect, useRef } from "react";

interface UseVisibilityRefreshOptions {
  /** Minimum gap between auto-refreshes, in ms. Defaults to 60_000. */
  minIntervalMs?: number;
  /** Skip the hook entirely (e.g. while a modal is open). Defaults to false. */
  disabled?: boolean;
}

export function useVisibilityRefresh(
  onRefresh: () => void | Promise<void>,
  { minIntervalMs = 60_000, disabled = false }: UseVisibilityRefreshOptions = {}
) {
  // Keep the latest callback in a ref so we don't re-bind listeners on every render.
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const lastRunRef = useRef<number>(Date.now());

  const maybeRefresh = useCallback(() => {
    if (disabled) return;
    const now = Date.now();
    if (now - lastRunRef.current < minIntervalMs) return;
    lastRunRef.current = now;
    void refreshRef.current();
  }, [disabled, minIntervalMs]);

  useEffect(() => {
    if (disabled) return;

    const onVisibility = () => {
      if (document.visibilityState === "visible") maybeRefresh();
    };
    const onFocus = () => maybeRefresh();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [disabled, maybeRefresh]);
}
