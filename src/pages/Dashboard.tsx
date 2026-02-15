import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useAutomationPoller } from "@/hooks/useAutomationPoller";
import { formatDistanceToNow } from "date-fns";
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

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [, setTick] = useState(0);
  const location = useLocation();

  useAutomationPoller();

  const [revenueStateFilter, setRevenueStateFilter] = useState<RevenueState>("active");

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
  }, [loadData, location.key]);

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
    };
  }, [metrics?.revenueStateCounts]);

  const activeCount = metrics?.active_count ?? 0;

  return (
    <div className="space-y-5">
      {/* Greeting Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">
            {getGreeting()}.
          </h1>
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground text-sm">
              Your assistant is monitoring {activeCount} active lead{activeCount !== 1 ? "s" : ""}.
            </p>
            {lastRefreshedAt && (
              <span className="text-xs text-muted-foreground/50">
                · Updated {formatDistanceToNow(lastRefreshedAt, { addSuffix: true })}
              </span>
            )}
          </div>
        </div>
        <Button asChild size="sm">
          <Link to="/app/leads">
            <Plus className="h-4 w-4 mr-1" />
            Add Lead
          </Link>
        </Button>
      </div>

      {/* ROW 1 — Command Strip */}
      <CommandStrip
        counts={commandCounts}
        activeFilter={revenueStateFilter}
        onFilterChange={setRevenueStateFilter}
      />

      {/* ROW 2 — Two Column Grid */}
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <PriorityActions leads={filteredLeads} allLeads={leads} revenueStateFilter={revenueStateFilter} onLeadUpdated={loadData} />
        </div>
        <div className="lg:col-span-2">
          <TopMovers leads={filteredLeads} />
        </div>
      </div>

      {/* ROW 3 — AI Insight */}
      <AIInsightPanel leads={filteredLeads} />

      {/* Lead Table */}
      <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} />
    </div>
  );
}
