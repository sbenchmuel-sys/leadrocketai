import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  EnrichedLead,
  DealStage,
  calculateReplyRate,
} from "@/lib/dashboardUtils";
import {
  getDashboardMetrics,
  refreshDashboard,
  onDashboardRefresh,
  type DashboardMetrics,
} from "@/lib/dashboardMetricsService";
import { SummaryCards, FilterType } from "@/components/dashboard/SummaryCards";
import { DealFlowBar } from "@/components/dashboard/DealFlowBar";
import { IntelligenceCards } from "@/components/dashboard/IntelligenceCards";
import { ActionRequiredPanel } from "@/components/dashboard/ActionRequiredPanel";
import { LeadTable } from "@/components/dashboard/LeadTable";
import { AIRecommendation } from "@/components/dashboard/AIRecommendation";

export default function Dashboard() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [, setTick] = useState(0);
  const location = useLocation();

  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [activeStage, setActiveStage] = useState<DealStage | null>(null);

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

  // Executive card stats
  const execStats = useMemo(() => ({
    activeLeads: metrics?.active_count ?? 0,
    needsAction: metrics?.needs_action_count ?? 0,
    warmingUp: metrics?.warming_up_count ?? 0,
    automationRunning: metrics?.automation_running_count ?? 0,
  }), [metrics]);

  // Intelligence metrics
  const intelligenceMetrics = useMemo(() => {
    if (!metrics) return { staleCount: 0, staleLeads: [], nurtureCandidateCount: 0, nurtureCandidates: [], momentum: 0, replyRate: 0 };
    return {
      staleCount: metrics.stale_count,
      staleLeads: metrics.staleLeads,
      nurtureCandidateCount: metrics.nurture_ready_count,
      nurtureCandidates: metrics.nurtureCandidates,
      momentum: metrics.momentum_score,
      replyRate: calculateReplyRate(leads),
    };
  }, [metrics, leads]);

  // Stage counts
  const stageCounts = useMemo(() => {
    const counts: Record<DealStage, number> = {
      new: 0, contacted: 0, engaged: 0, post_meeting: 0, closing: 0, closed_won: 0, closed_lost: 0,
    };
    leads.forEach((l) => {
      if (counts[l.stage] !== undefined) counts[l.stage]++;
    });
    return counts;
  }, [leads]);

  // Cooling down: leads that were recently active but momentum is stalling
  const coolingDownCount = useMemo(() => {
    const now = new Date();
    return leads.filter((l) => {
      if (l.stage === "closed_won" || l.stage === "closed_lost") return false;
      if (!l.last_activity_at) return false;
      const daysSince = (now.getTime() - new Date(l.last_activity_at).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince >= 7 && daysSince < 14 && l.stage !== "new";
    }).length;
  }, [leads]);

  // Filter leads
  const filteredLeads = useMemo(() => {
    let result = leads;

    if (activeFilter === "active") {
      result = result.filter((l) => l.stage !== "closed_won" && l.stage !== "closed_lost");
    } else if (activeFilter === "needs_action") {
      result = result.filter((l) => l.needs_action);
    } else if (activeFilter === "meetings") {
      result = result.filter((l) => l.hasMeeting);
    } else if (activeFilter === "stale") {
      result = intelligenceMetrics.staleLeads;
    } else if (activeFilter === "nurture_candidates") {
      result = intelligenceMetrics.nurtureCandidates;
    } else if (activeFilter === "warming_up") {
      result = metrics?.warmingUpLeads ?? [];
    } else if (activeFilter === "automation") {
      result = result.filter((l) => l.nurture_mode === "auto" && l.nurture_status === "active");
    }

    if (activeStage) {
      result = result.filter((l) => l.stage === activeStage);
    }

    return result;
  }, [leads, activeFilter, activeStage, intelligenceMetrics.staleLeads, intelligenceMetrics.nurtureCandidates, metrics?.warmingUpLeads]);

  const handleFilterChange = (filter: FilterType) => {
    setActiveFilter(filter);
    setActiveStage(null);
  };

  const handleStageClick = (stage: DealStage | null) => {
    setActiveStage(stage);
  };

  const handleStaleClick = () => handleCardClick("stale" as FilterType);
  const handleNurtureClick = () => handleCardClick("nurture_candidates" as FilterType);

  const handleCardClick = (filter: FilterType) => {
    setActiveFilter(activeFilter === filter ? "all" : filter);
    setActiveStage(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground">Your B2B Deal Assistant</p>
            {lastRefreshedAt && (
              <span className="text-xs text-muted-foreground/60">
                · Updated {formatDistanceToNow(lastRefreshedAt, { addSuffix: true })}
              </span>
            )}
          </div>
        </div>
        <Button asChild>
          <Link to="/dashboard/leads">
            <Plus className="h-4 w-4 mr-2" />
            Add Lead
          </Link>
        </Button>
      </div>

      {/* Executive Metric Cards */}
      <SummaryCards
        activeLeads={execStats.activeLeads}
        needsAction={execStats.needsAction}
        warmingUp={execStats.warmingUp}
        automationRunning={execStats.automationRunning}
        isLoading={isLoading}
        onCardClick={handleCardClick}
        activeFilter={activeFilter}
      />

      {/* Intelligence Cards */}
      <IntelligenceCards
        staleCount={intelligenceMetrics.staleCount}
        momentum={intelligenceMetrics.momentum}
        replyRate={intelligenceMetrics.replyRate}
        nurtureCandidateCount={intelligenceMetrics.nurtureCandidateCount}
        onStaleClick={handleStaleClick}
        onNurtureClick={handleNurtureClick}
        activeFilter={activeFilter}
      />

      {/* Deal Flow Bar */}
      <DealFlowBar
        stageCounts={stageCounts}
        activeStage={activeStage}
        onStageClick={handleStageClick}
      />

      {/* Two Column Layout for Action Panel and AI */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ActionRequiredPanel leads={leads} onLeadUpdated={loadData} />
        </div>
        <div>
          <AIRecommendation
            warmingUpLeads={metrics?.warmingUpLeads ?? []}
            coolingDownCount={coolingDownCount}
            nurtureCandidates={intelligenceMetrics.nurtureCandidateCount}
            atRisk={intelligenceMetrics.staleCount}
          />
        </div>
      </div>

      {/* Lead Table */}
      <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} />
    </div>
  );
}
