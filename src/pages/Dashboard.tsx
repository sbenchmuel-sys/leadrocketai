import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  EnrichedLead,
  DealStage,
  getAIRecommendation,
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
  const [, setTick] = useState(0); // force re-render for relative time
  const location = useLocation();

  // Filters
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

  // Load data on mount and when navigating back to dashboard
  useEffect(() => {
    loadData();
  }, [loadData, location.key]);

  // Subscribe to refresh events from other parts of the app
  useEffect(() => {
    const unsub = onDashboardRefresh((_reason, m) => {
      setMetrics(m);
      setLastRefreshedAt(new Date());
    });
    return unsub;
  }, []);

  // Tick every 30s to update the relative time label
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const leads = metrics?.leads ?? [];

  // Executive card stats from metrics service
  const execStats = useMemo(() => ({
    needsAction: metrics?.needs_action_count ?? 0,
    closing: metrics?.closing_count ?? 0,
    automationRunning: metrics?.automation_running_count ?? 0,
    momentum: metrics?.momentum_score ?? 0,
  }), [metrics]);

  // Intelligence metrics from service
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

  // Calculate stage counts
  const stageCounts = useMemo(() => {
    const counts: Record<DealStage, number> = {
      new: 0, contacted: 0, engaged: 0, post_meeting: 0, closing: 0, closed_won: 0, closed_lost: 0,
    };
    leads.forEach((l) => {
      if (counts[l.stage] !== undefined) counts[l.stage]++;
    });
    return counts;
  }, [leads]);

  // Filter leads based on active filters
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
    }

    if (activeStage) {
      result = result.filter((l) => l.stage === activeStage);
    }

    return result;
  }, [leads, activeFilter, activeStage, intelligenceMetrics.staleLeads, intelligenceMetrics.nurtureCandidates]);

  // AI insights
  const aiInsights = useMemo(() => {
    const warmingUp = leads.filter(
      (l) => l.stage === "engaged" || l.stage === "post_meeting"
    ).length;
    const atRisk = intelligenceMetrics.staleCount;
    const recs = getAIRecommendation(leads);
    return { warmingUp, atRisk, topRecommendation: recs[0] ?? null };
  }, [leads, intelligenceMetrics.staleCount]);

  const handleFilterChange = (filter: FilterType) => {
    setActiveFilter(filter);
    setActiveStage(null);
  };

  const handleStageClick = (stage: DealStage | null) => {
    setActiveStage(stage);
  };

  const handleStaleClick = () => {
    setActiveFilter(activeFilter === "stale" ? "all" : "stale");
    setActiveStage(null);
  };

  const handleNurtureClick = () => {
    setActiveFilter(activeFilter === "nurture_candidates" ? "all" : "nurture_candidates");
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
        needsAction={execStats.needsAction}
        closing={execStats.closing}
        automationRunning={execStats.automationRunning}
        momentum={execStats.momentum}
        isLoading={isLoading}
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
            warmingUp={aiInsights.warmingUp}
            atRisk={aiInsights.atRisk}
            nurtureCandidates={intelligenceMetrics.nurtureCandidateCount}
            topRecommendation={aiInsights.topRecommendation}
          />
        </div>
      </div>

      {/* Lead Table */}
      <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} />
    </div>
  );
}
