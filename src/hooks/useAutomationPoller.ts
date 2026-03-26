import { useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { refreshDashboard } from "@/lib/dashboardMetricsService";

// ── Client-side automation poller ────────────────────────────
// This is a SECONDARY refresh helper — the primary scheduler is
// pg_cron → cron-dispatcher → automation-executor (every 15 min).
// This poller provides near-realtime toast notifications when
// the user has the dashboard open.
const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes (relaxed — cron is primary)

export function useAutomationPoller() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPollingRef = useRef(false);

  const poll = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      // Only check for recent automation results — don't trigger execution
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: recentSends } = await supabase
        .from("automation_log")
        .select("lead_id, subject")
        .eq("status", "sent")
        .gte("completed_at", fiveMinAgo)
        .order("completed_at", { ascending: false })
        .limit(3);

      if (recentSends && recentSends.length > 0) {
        toast.success(`${recentSends.length} auto-send(s) completed`, {
          duration: 5000,
        });
        refreshDashboard("automation_send");
      }
    } catch (err) {
      console.debug("[useAutomationPoller] Poll error:", err);
    } finally {
      isPollingRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Initial check after 10s
    const initialTimeout = setTimeout(poll, 10_000);

    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);

    // Pause polling when tab is hidden
    const handleVisibility = () => {
      if (document.hidden) {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      } else {
        if (!timerRef.current) {
          poll();
          timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearTimeout(initialTimeout);
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [poll]);
}
