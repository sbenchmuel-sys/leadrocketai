import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useAutomationPoller } from "@/hooks/useAutomationPoller";
import { formatDistanceToNow } from "date-fns";
import { isDemoMode } from "@/lib/demoMode";
import { getDashboardState, setDashboardFilter, setDashboardScroll } from "@/lib/dashboardStateCache";
import type { RevenueState } from "@/lib/dashboardUtils";
import {
  getDashboardMetrics,
  onDashboardRefresh,
  type DashboardMetrics,
} from "@/lib/dashboardMetricsService";
import { CommandStrip, DashboardFilter } from "@/components/dashboard/CommandStrip";
import { PriorityActions } from "@/components/dashboard/PriorityActions";
import { TopMovers } from "@/components/dashboard/TopMovers";
import { AIInsightPanel } from "@/components/dashboard/AIInsightPanel";
import { LeadTable } from "@/components/dashboard/LeadTable";

export default function Dashboard() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [, setTick] = useState(0);
  const location = useLocation();

  if (!isDemoMode()) useAutomationPoller();

  const [revenueStateFilter, setRevenueStateFilterLocal] = useState<RevenueState>(getDashboardState().revenueStateFilter);

  const handleFilterChange = useCallback((filter: RevenueState) => {
    setRevenueStateFilterLocal(filter);
    setDashboardFilter(filter);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const m = await getDashboardMetrics();
      setMetrics(m);
      setLastRefreshedAt(new Date());
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    // Restore scroll position
    const { scrollY } = getDashboardState();
    if (scrollY > 0) {
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  }, [loadData, location.key]);

  // Persist scroll position on unmount
  useEffect(() => {
    return () => {
      setDashboardScroll(window.scrollY);
    };
  }, []);

  useEffect(() => {
    const unsub = onDashboardRefresh((_reason, m) => {
      setMetrics(m);
      setLastRefreshedAt(new Date());
    });
    return unsub;
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const leads = metrics?.leads ?? [];

  // --- Centralized Revenue State filtering ---
  const filteredLeads = useMemo(() => {
    return leads.filter((l) => l.revenueState === revenueStateFilter);
  }, [leads, revenueStateFilter]);

  // --- Command strip counts from centralized metrics ---
  const commandCounts = useMemo<Record<DashboardFilter, number>>(() => {
    return metrics?.revenueStateCounts ?? {
      active: 0,
      action_required: 0,
      heating_up: 0,
      long_cycle: 0,
      automation: 0,
    };
  }, [metrics?.revenueStateCounts]);

  const activeCount = metrics?.active_count ?? 0;

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground tracking-wide uppercase">Revenue Engine</p>
          <p className="text-lg font-semibold text-foreground tracking-tight mt-0.5">
            {activeCount} Active Conversations
            <span className="text-muted-foreground mx-1.5">·</span>
            {commandCounts.action_required} Pending Intervention
          </p>
        </div>
        {!isDemoMode() && (
          <Button asChild size="sm">
            <Link to="/app/leads">
              <Plus className="h-4 w-4 mr-1" />
              Add Lead
            </Link>
          </Button>
        )}
      </div>

      {/* Command Strip */}
      <CommandStrip
        counts={commandCounts}
        activeFilter={revenueStateFilter}
        onFilterChange={handleFilterChange}
      />

      {/* Action Required + Top Movers */}
      {revenueStateFilter === "heating_up" ? (
        <>
          {/* Heating Up: hide Action Required, show Top Movers full-width */}
          <TopMovers leads={filteredLeads} />
          {/* Revenue Signal */}
          <AIInsightPanel leads={filteredLeads} />
          {/* Lead Table — give it more vertical weight */}
          <div className="min-h-[60vh]">
            <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} revenueStateFilter={revenueStateFilter} />
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <PriorityActions leads={filteredLeads} allLeads={leads} revenueStateFilter={revenueStateFilter} onLeadUpdated={loadData} />
            </div>
            <div className="lg:col-span-2">
              <TopMovers leads={filteredLeads} />
            </div>
          </div>
          {/* Revenue Signal */}
          <AIInsightPanel leads={filteredLeads} />
          {/* Lead Table */}
          <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} revenueStateFilter={revenueStateFilter} />
        </>
      )}
    </div>
  );
}
