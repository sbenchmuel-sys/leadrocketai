import { useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { refreshDashboard } from "@/lib/dashboardMetricsService";

const POLL_INTERVAL_MS = 60_000; // 60 seconds

export function useAutomationPoller() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPollingRef = useRef(false);

  const poll = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const res = await supabase.functions.invoke("automation-check", {});
      const result = res.data;

      if (result?.ok && result.processed > 0) {
        const sentLeads = result.sentLeads || [];
        if (sentLeads.length > 0) {
          const first = sentLeads[0];
          toast.success(`Auto-sent "${first.subject}" to ${first.leadName}`, {
            duration: 5000,
          });
        }
        // Refresh dashboard metrics
        refreshDashboard("automation_send");
      }
    } catch (err) {
      // Silent fail — don't spam user with polling errors
      console.debug("[useAutomationPoller] Poll error:", err);
    } finally {
      isPollingRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Initial poll after 5s
    const initialTimeout = setTimeout(poll, 5000);

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
