import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus, LayoutGrid, Table2 } from "lucide-react";
import { useAutomationPoller } from "@/hooks/useAutomationPoller";
import { isDemoMode } from "@/lib/demoMode";
import { flags } from "@/lib/featureFlags";
import {
  getDashboardState,
  setDashboardFilter,
  setDashboardScroll,
  setDashboardViewMode,
  type ViewMode,
} from "@/lib/dashboardStateCache";
import type { RevenueState, EnrichedLead } from "@/lib/dashboardUtils";
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
import { LeadCard, LeadCardSkeleton } from "@/components/leads/LeadCard";

const QUEUE_LIMIT = 15;

function sortForQueue(leads: EnrichedLead[]): EnrichedLead[] {
  return [...leads].sort((a, b) => {
    // needs_action first
    if (a.needs_action && !b.needs_action) return -1;
    if (!a.needs_action && b.needs_action) return 1;
    // then by last_activity_at desc
    const aT = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0;
    const bT = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0;
    return bT - aT;
  });
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [, setTick] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();

  if (!isDemoMode()) useAutomationPoller();

  const [revenueStateFilter, setRevenueStateFilterLocal] = useState<RevenueState>(getDashboardState().revenueStateFilter);
  const [viewMode, setViewModeLocal] = useState<ViewMode>(getDashboardState().viewMode);

  const handleFilterChange = useCallback((filter: RevenueState) => {
    setRevenueStateFilterLocal(filter);
    setDashboardFilter(filter);
  }, []);

  const handleViewMode = useCallback((mode: ViewMode) => {
    setViewModeLocal(mode);
    setDashboardViewMode(mode);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const m = await getDashboardMetrics();
      setMetrics(m);
      setLastRefreshedAt(new Date());
      if (!getDashboardState().filterTouched && getDashboardState().revenueStateFilter === "active" && m.revenueStateCounts.action_required > 0) {
        handleFilterChange("action_required");
      }
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
    } finally {
      setIsLoading(false);
    }
  }, [handleFilterChange]);

  useEffect(() => {
    loadData();
    const { scrollY } = getDashboardState();
    if (scrollY > 0) {
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  }, [loadData, location.key]);

  useEffect(() => {
    return () => { setDashboardScroll(window.scrollY); };
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

  const filteredLeads = useMemo(() => {
    if (revenueStateFilter === "active") return leads;
    return leads.filter((l) => l.revenueState === revenueStateFilter);
  }, [leads, revenueStateFilter]);

  const queueLeads = useMemo(() => sortForQueue(filteredLeads).slice(0, QUEUE_LIMIT), [filteredLeads]);

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
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Revenue Engine</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {activeCount} Active Conversations
            <span className="mx-1.5">·</span>
            {commandCounts.action_required} Pending Intervention
          </p>
        </div>
        <div className="flex items-center gap-2">
          {flags.ui_v2 && (
            <div className="flex items-center border border-border rounded-md overflow-hidden">
              <Button
                variant={viewMode === "queue" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                onClick={() => handleViewMode("queue")}
                title="Queue view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={viewMode === "table" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                onClick={() => handleViewMode("table")}
                title="Table view"
              >
                <Table2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {!isDemoMode() && (
            <Button asChild size="sm">
              <Link to="/app/leads">
                <Plus className="h-4 w-4 mr-1" />
                Add Lead
              </Link>
            </Button>
          )}
        </div>
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
          <TopMovers leads={filteredLeads} />
          <AIInsightPanel leads={filteredLeads} />
          <div className="min-h-[60vh]">
            {viewMode === "queue" ? (
              <QueueView leads={queueLeads} isLoading={isLoading} navigate={navigate} />
            ) : (
              <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} revenueStateFilter={revenueStateFilter} />
            )}
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
          <AIInsightPanel leads={filteredLeads} />
          {viewMode === "queue" ? (
            <QueueView leads={queueLeads} isLoading={isLoading} navigate={navigate} />
          ) : (
            <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} revenueStateFilter={revenueStateFilter} />
          )}
        </>
      )}
    </div>
  );
}

// ── Queue sub-component ────────────────────────────────────────────────

function QueueView({
  leads,
  isLoading,
  navigate,
}: {
  leads: EnrichedLead[];
  isLoading: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  if (isLoading) {
    return (
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <LeadCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (!leads.length) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">No leads match this filter.</p>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {leads.map((lead) => (
        <LeadCard
          key={lead.id}
          lead={lead}
          context="dashboard"
          primaryAction={{
            label: lead.needs_action ? "Handle now" : "Open",
            onClick: () => navigate(`/app/lead/${lead.id}`),
          }}
        />
      ))}
    </div>
  );
}
