import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  enrichLead,
  EnrichedLead,
  DealStage,
  STAGE_ORDER,
  getAIRecommendation,
  getStaleLeads,
  getNurtureCandidates,
  calculateMomentum,
  calculateReplyRate,
} from "@/lib/dashboardUtils";
import { SummaryCards, FilterType } from "@/components/dashboard/SummaryCards";
import { DealFlowBar } from "@/components/dashboard/DealFlowBar";
import { IntelligenceCards } from "@/components/dashboard/IntelligenceCards";
import { ActionRequiredPanel } from "@/components/dashboard/ActionRequiredPanel";
import { LeadTable } from "@/components/dashboard/LeadTable";
import { AIRecommendation } from "@/components/dashboard/AIRecommendation";

export default function Dashboard() {
  const [leads, setLeads] = useState<EnrichedLead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const location = useLocation();

  // Filters
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [activeStage, setActiveStage] = useState<DealStage | null>(null);

  const loadData = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Fetch leads with new fields
      const { data: leadsData, error } = await supabase
        .from("leads")
        .select(`
          id, company, name, email, strategy, status, owner_user_id, 
          created_at, last_activity_at, next_step, deal_outlook, country,
          stage, needs_action, next_action_key, next_action_label, action_reason_code,
          meeting_summary_count, last_outbound_at, last_inbound_at, first_outbound_at,
          nurture_cadence, auto_nurture_eligible, source_type, motion
        `)
        .order("last_activity_at", { ascending: false })
        .limit(200);

      if (error) throw error;

      const enrichedLeads = (leadsData || []).map(enrichLead);
      setLeads(enrichedLeads);
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


  // Calculate summary stats
  const stats = useMemo(() => {
    const total = leads.length;
    const active = leads.filter(
      (l) => l.stage !== "closed_won" && l.stage !== "closed_lost"
    ).length;
    const needsAction = leads.filter((l) => l.needs_action).length;
    const meetings = leads.filter((l) => l.hasMeeting).length;
    return { total, active, needsAction, meetings };
  }, [leads]);

  // Calculate intelligence metrics
  const intelligenceMetrics = useMemo(() => {
    const staleLeads = getStaleLeads(leads);
    const nurtureCandidates = getNurtureCandidates(leads);
    const momentum = calculateMomentum(leads);
    const replyRate = calculateReplyRate(leads);
    return { 
      staleCount: staleLeads.length, 
      staleLeads, 
      nurtureCandidateCount: nurtureCandidates.length,
      nurtureCandidates,
      momentum, 
      replyRate 
    };
  }, [leads]);

  // Calculate stage counts
  const stageCounts = useMemo(() => {
    const counts: Record<DealStage, number> = {
      new: 0,
      contacted: 0,
      engaged: 0,
      post_meeting: 0,
      closing: 0,
      closed_won: 0,
      closed_lost: 0,
    };
    leads.forEach((l) => {
      if (counts[l.stage] !== undefined) {
        counts[l.stage]++;
      }
    });
    return counts;
  }, [leads]);

  // Filter leads based on active filters
  const filteredLeads = useMemo(() => {
    let result = leads;

    // Apply summary card filter
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

    // Apply stage filter
    if (activeStage) {
      result = result.filter((l) => l.stage === activeStage);
    }

    return result;
  }, [leads, activeFilter, activeStage, intelligenceMetrics.staleLeads, intelligenceMetrics.nurtureCandidates]);

  // AI recommendations
  const recommendations = useMemo(() => {
    return getAIRecommendation(leads);
  }, [leads]);

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
          <p className="text-muted-foreground">Your B2B Deal Assistant</p>
        </div>
        <Button asChild>
          <Link to="/dashboard/leads">
            <Plus className="h-4 w-4 mr-2" />
            Add Lead
          </Link>
        </Button>
      </div>

      {/* Summary Cards */}
      <SummaryCards
        total={stats.total}
        active={stats.active}
        needsAction={stats.needsAction}
        meetings={stats.meetings}
        activeFilter={activeFilter}
        onFilterChange={handleFilterChange}
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
          <AIRecommendation recommendations={recommendations} />
        </div>
      </div>

      {/* Lead Table */}
      <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} />
    </div>
  );
}
