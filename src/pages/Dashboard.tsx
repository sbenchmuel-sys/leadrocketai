import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useAutomationPoller } from "@/hooks/useAutomationPoller";
import { formatDistanceToNow } from "date-fns";
import { differenceInDays, parseISO } from "date-fns";
import {
  EnrichedLead,
  DealStage,
} from "@/lib/dashboardUtils";
import {
  getDashboardMetrics,
  onDashboardRefresh,
  type DashboardMetrics,
} from "@/lib/dashboardMetricsService";
import { CommandStrip, DashboardFilter } from "@/components/dashboard/CommandStrip";
import { StageFilterBar, StageFilter } from "@/components/dashboard/StageFilterBar";
import { PriorityActions } from "@/components/dashboard/PriorityActions";
import { AIActivityFeed } from "@/components/dashboard/AIActivityFeed";
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

  const [dashboardFilter, setDashboardFilter] = useState<DashboardFilter>("active");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");

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

  // --- Dashboard filter logic ---
  const dashboardFiltered = useMemo(() => {
    const now = new Date();
    switch (dashboardFilter) {
      case "active":
        return leads.filter((l) => l.stage !== "closed_won" && l.stage !== "closed_lost");
      case "need_you":
        return leads.filter((l) => l.needs_action);
      case "heating_up":
        return metrics?.warmingUpLeads ?? [];
      case "at_risk":
        return leads.filter((l) => {
          if (l.stage === "closed_won" || l.stage === "closed_lost") return false;
          if (!l.last_outbound_at) {
            if (l.created_at) return differenceInDays(now, parseISO(l.created_at)) > 14;
            return false;
          }
          return differenceInDays(now, parseISO(l.last_outbound_at)) > 14;
        });
      default:
        return leads;
    }
  }, [leads, dashboardFilter, metrics?.warmingUpLeads]);

  // --- Stage filter logic ---
  const filteredLeads = useMemo(() => {
    if (stageFilter === "all") return dashboardFiltered;
    if (stageFilter === "nurture") {
      return dashboardFiltered.filter((l) => l.motion === "nurture");
    }
    return dashboardFiltered.filter((l) => l.stage === stageFilter);
  }, [dashboardFiltered, stageFilter]);

  // --- Command strip counts ---
  const commandCounts = useMemo(() => {
    const now = new Date();
    const active = leads.filter((l) => l.stage !== "closed_won" && l.stage !== "closed_lost");
    return {
      active: active.length,
      need_you: leads.filter((l) => l.needs_action).length,
      heating_up: (metrics?.warmingUpLeads ?? []).length,
      at_risk: leads.filter((l) => {
        if (l.stage === "closed_won" || l.stage === "closed_lost") return false;
        if (!l.last_outbound_at) {
          if (l.created_at) return differenceInDays(now, parseISO(l.created_at)) > 14;
          return false;
        }
        return differenceInDays(now, parseISO(l.last_outbound_at)) > 14;
      }).length,
    };
  }, [leads, metrics?.warmingUpLeads]);

  // --- Stage filter counts (from dashboardFiltered) ---
  const stageCounts = useMemo(() => {
    const counts: Record<StageFilter, number> = {
      all: dashboardFiltered.length,
      new: 0,
      contacted: 0,
      engaged: 0,
      post_meeting: 0,
      nurture: 0,
    };
    dashboardFiltered.forEach((l) => {
      if (l.motion === "nurture") counts.nurture++;
      if (l.stage === "new") counts.new++;
      else if (l.stage === "contacted") counts.contacted++;
      else if (l.stage === "engaged") counts.engaged++;
      else if (l.stage === "post_meeting") counts.post_meeting++;
    });
    return counts;
  }, [dashboardFiltered]);

  const activeCount = commandCounts.active;

  return (
    <div className="space-y-6">
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
        activeFilter={dashboardFilter}
        onFilterChange={(f) => {
          setDashboardFilter(f);
          setStageFilter("all");
        }}
      />


      {/* ROW 3 — Two Column Grid */}
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <PriorityActions leads={filteredLeads} onLeadUpdated={loadData} />
        </div>
        <div className="lg:col-span-2">
          <AIActivityFeed leads={filteredLeads} />
        </div>
      </div>

      {/* ROW 4 — AI Insight */}
      <AIInsightPanel leads={filteredLeads} />

      {/* Lead Table */}
      <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} />
    </div>
  );
}
