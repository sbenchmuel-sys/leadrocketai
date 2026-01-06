import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { getLeadsList, LeadListItem } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import {
  enrichLeadWithContext,
  LeadWithContext,
  DealStage,
  STAGE_ORDER,
  getAIRecommendation,
} from "@/lib/dashboardUtils";
import { SummaryCards, FilterType } from "@/components/dashboard/SummaryCards";
import { DealFlowBar } from "@/components/dashboard/DealFlowBar";
import { ActionRequiredPanel } from "@/components/dashboard/ActionRequiredPanel";
import { LeadTable } from "@/components/dashboard/LeadTable";
import { AIRecommendation } from "@/components/dashboard/AIRecommendation";

export default function Dashboard() {
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [interactionsMap, setInteractionsMap] = useState<Record<string, { type: string; source: string; ai_reply_worthy: boolean | null; body_text: string; occurred_at: string }[]>>({});
  const [draftsMap, setDraftsMap] = useState<Record<string, { status: string }[]>>({});

  // Filters
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [activeStage, setActiveStage] = useState<DealStage | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const leadsList = await getLeadsList();
      setLeads(leadsList);

      if (leadsList.length > 0) {
        // Fetch interactions for all leads
        const leadIds = leadsList.map((l) => l.id);
        const { data: interactions } = await supabase
          .from("interactions")
          .select("lead_id, type, source, ai_reply_worthy, body_text, occurred_at")
          .in("lead_id", leadIds);

        const intMap: Record<string, typeof interactions> = {};
        (interactions || []).forEach((i) => {
          if (!intMap[i.lead_id]) intMap[i.lead_id] = [];
          intMap[i.lead_id].push(i);
        });
        setInteractionsMap(intMap);

        // Fetch drafts for all leads
        const { data: drafts } = await supabase
          .from("drafts")
          .select("lead_id, status")
          .in("lead_id", leadIds);

        const draftMap: Record<string, { status: string }[]> = {};
        (drafts || []).forEach((d) => {
          if (!draftMap[d.lead_id]) draftMap[d.lead_id] = [];
          draftMap[d.lead_id].push({ status: d.status });
        });
        setDraftsMap(draftMap);
      }
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
    } finally {
      setIsLoading(false);
    }
  }

  // Enrich leads with context
  const enrichedLeads: LeadWithContext[] = useMemo(() => {
    return leads.map((lead) => {
      const interactions = (interactionsMap[lead.id] || []).map((i) => ({
        id: "",
        lead_id: lead.id,
        type: i.type,
        source: i.source,
        ai_reply_worthy: i.ai_reply_worthy,
        body_text: i.body_text,
        occurred_at: i.occurred_at,
        subject: null,
        from_email: null,
        to_email: null,
        ai_summary: null,
        ai_intent: null,
        gmail_message_id: null,
      }));
      const drafts = draftsMap[lead.id] || [];
      return enrichLeadWithContext(lead, interactions, drafts);
    });
  }, [leads, interactionsMap, draftsMap]);

  // Calculate summary stats
  const stats = useMemo(() => {
    const total = enrichedLeads.length;
    const active = enrichedLeads.filter(
      (l) => l.status !== "closed_won" && l.status !== "closed_lost"
    ).length;
    const needsAction = enrichedLeads.filter((l) => l.needsAction).length;
    const meetings = enrichedLeads.filter((l) => l.hasMeeting).length;
    return { total, active, needsAction, meetings };
  }, [enrichedLeads]);

  // Calculate stage counts
  const stageCounts = useMemo(() => {
    const counts: Record<DealStage, number> = {
      new: 0,
      contacted: 0,
      engaged: 0,
      post_meeting: 0,
      closing: 0,
    };
    enrichedLeads.forEach((l) => {
      counts[l.stage]++;
    });
    return counts;
  }, [enrichedLeads]);

  // Filter leads based on active filters
  const filteredLeads = useMemo(() => {
    let result = enrichedLeads;

    // Apply summary card filter
    if (activeFilter === "active") {
      result = result.filter((l) => l.status !== "closed_won" && l.status !== "closed_lost");
    } else if (activeFilter === "needs_action") {
      result = result.filter((l) => l.needsAction);
    } else if (activeFilter === "meetings") {
      result = result.filter((l) => l.hasMeeting);
    }

    // Apply stage filter
    if (activeStage) {
      result = result.filter((l) => l.stage === activeStage);
    }

    return result;
  }, [enrichedLeads, activeFilter, activeStage]);

  // AI recommendations
  const recommendations = useMemo(() => {
    return getAIRecommendation(enrichedLeads);
  }, [enrichedLeads]);

  const handleFilterChange = (filter: FilterType) => {
    setActiveFilter(filter);
    setActiveStage(null); // Reset stage when changing card filter
  };

  const handleStageClick = (stage: DealStage | null) => {
    setActiveStage(stage);
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

      {/* Deal Flow Bar */}
      <DealFlowBar
        stageCounts={stageCounts}
        activeStage={activeStage}
        onStageClick={handleStageClick}
      />

      {/* Two Column Layout for Action Panel and AI */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ActionRequiredPanel leads={enrichedLeads} />
        </div>
        <div>
          <AIRecommendation recommendations={recommendations} />
        </div>
      </div>

      {/* Lead Table */}
      <LeadTable leads={filteredLeads} isLoading={isLoading} />
    </div>
  );
}
