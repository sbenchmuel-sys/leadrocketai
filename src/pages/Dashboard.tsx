import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus, Sparkles, Mail, CalendarCheck, FileText } from "lucide-react";
import { useAutomationPoller } from "@/hooks/useAutomationPoller";
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

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function AIActivityPanel({ leads }: { leads: EnrichedLead[] }) {
  // Build activity items from lead data
  const activities = useMemo(() => {
    const items: { icon: typeof Mail; label: string; detail: string; time: string }[] = [];

    // Find recent drafts (leads with needs_action and action labels)
    const actionLeads = leads
      .filter((l) => l.needs_action && l.next_action_label)
      .sort((a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime())
      .slice(0, 2);

    actionLeads.forEach((l) => {
      items.push({
        icon: FileText,
        label: "Draft created",
        detail: `${l.next_action_label} for ${l.name}`,
        time: formatDistanceToNow(new Date(l.last_activity_at), { addSuffix: true }),
      });
    });

    // Find leads with recent inbound (reply detected)
    const replyLeads = leads
      .filter((l) => l.last_inbound_at)
      .sort((a, b) => new Date(b.last_inbound_at!).getTime() - new Date(a.last_inbound_at!).getTime())
      .slice(0, 2);

    replyLeads.forEach((l) => {
      items.push({
        icon: Mail,
        label: "Reply detected",
        detail: `${l.name} from ${l.company}`,
        time: formatDistanceToNow(new Date(l.last_inbound_at!), { addSuffix: true }),
      });
    });

    // Automation scheduled
    const autoLeads = leads
      .filter((l) => (l as any).nurture_mode === "auto" && (l as any).nurture_status === "active")
      .slice(0, 2);

    autoLeads.forEach((l) => {
      items.push({
        icon: CalendarCheck,
        label: "Follow-up scheduled",
        detail: l.name,
        time: "Queued",
      });
    });

    return items.slice(0, 6);
  }, [leads]);

  return (
    <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Assistant Activity</h3>
      </div>

      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No recent activity yet.</p>
      ) : (
        <div className="space-y-3">
          {activities.map((a, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="mt-0.5 h-7 w-7 rounded-lg bg-muted flex items-center justify-center shrink-0">
                <a.icon className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">{a.label}</p>
                <p className="text-[11px] text-muted-foreground truncate">{a.detail}</p>
              </div>
              <span className="text-[10px] text-muted-foreground/60 shrink-0 mt-0.5">{a.time}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [, setTick] = useState(0);
  const location = useLocation();

  // Poll automation-executor every 60s while dashboard is open
  useAutomationPoller();

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

  // Cooling down
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
      result = result.filter((l) => {
        const hasSequenceAutomation = !!(l as any).eligible_at && l.needs_action;
        const hasNurtureAutomation = l.nurture_mode === "auto" && l.nurture_status === "active";
        return hasSequenceAutomation || hasNurtureAutomation;
      });
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
    <div className="space-y-8">
      {/* Greeting Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-4xl font-semibold text-foreground tracking-tight">
            {getGreeting()}.
          </h1>
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground text-[15px]">
              Your assistant is monitoring {execStats.activeLeads} active lead{execStats.activeLeads !== 1 ? "s" : ""}.
            </p>
            {lastRefreshedAt && (
              <span className="text-xs text-muted-foreground/50">
                · Updated {formatDistanceToNow(lastRefreshedAt, { addSuffix: true })}
              </span>
            )}
          </div>
        </div>
        <Button asChild className="h-10">
          <Link to="/app/leads">
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

      {/* Two Column Layout for Action Panel + AI Activity */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <ActionRequiredPanel leads={leads} onLeadUpdated={loadData} />
          <AIRecommendation
            warmingUpLeads={metrics?.warmingUpLeads ?? []}
            coolingDownCount={coolingDownCount}
            nurtureCandidates={intelligenceMetrics.nurtureCandidateCount}
            atRisk={intelligenceMetrics.staleCount}
          />
        </div>
        <div>
          <AIActivityPanel leads={leads} />
        </div>
      </div>

      {/* Lead Table */}
      <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} />
    </div>
  );
}
