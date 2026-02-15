import { useEffect, useState, useMemo, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAutomationPoller } from "@/hooks/useAutomationPoller";
import type { EnrichedLead } from "@/lib/dashboardUtils";
import {
  getDashboardMetrics,
  onDashboardRefresh,
  type DashboardMetrics,
} from "@/lib/dashboardMetricsService";
import { CommandStrip, DashboardFilter } from "@/components/dashboard/CommandStrip";
import { ActionQueue, classifyLead } from "@/components/dashboard/ActionQueue";
import { AIFocusPanel } from "@/components/dashboard/AIFocusPanel";
import { LeadTable } from "@/components/dashboard/LeadTable";
import { STAGE_LABELS, DealStage } from "@/lib/dashboardUtils";

export default function Dashboard() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [, setTick] = useState(0);
  const location = useLocation();

  useAutomationPoller();

  const [dashboardFilter, setDashboardFilter] = useState<DashboardFilter>("active");

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

  const filteredLeads = useMemo(() => {
    switch (dashboardFilter) {
      case "active":
        return leads.filter((l) => l.stage !== "closed_won" && l.stage !== "closed_lost");
      case "need_you":
        return leads.filter((l) => l.needs_action);
      default:
        return leads;
    }
  }, [leads, dashboardFilter]);

  const commandCounts = useMemo(() => {
    const active = leads.filter((l) => l.stage !== "closed_won" && l.stage !== "closed_lost");
    return {
      active: active.length,
      need_you: leads.filter((l) => l.needs_action).length,
    };
  }, [leads]);

  const needYouCount = commandCounts.need_you;

  const topFocusItem = useMemo(() => {
    for (const lead of filteredLeads) {
      const item = classifyLead(lead);
      if (item) {
        const stage = STAGE_LABELS[item.lead.stage as DealStage] ?? item.lead.stage;
        const buttonLabel =
          item.actionType === "Reply" ? "Reply Now" :
          item.actionType === "Call" ? "Call" :
          item.actionType === "Send Proposal" ? "Send" :
          item.actionType === "Follow-up" ? "Follow Up" : "Review";
        return {
          leadId: item.lead.id,
          leadName: item.lead.name,
          stage,
          reason: item.reason,
          buttonLabel,
        };
      }
    }
    return null;
  }, [filteredLeads]);

  return (
    <div className="space-y-6">
      {/* Header — Action-focused */}
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold text-foreground tracking-tight">
          You have {needYouCount} action{needYouCount !== 1 ? "s" : ""} pending.
        </h1>
        <p className="text-sm text-muted-foreground">Sorted by urgency.</p>
        <div className="pt-2">
          <Button
            size="sm"
            onClick={() => {
              setDashboardFilter("need_you");
              const el = document.getElementById("action-queue");
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            Review Actions
          </Button>
        </div>
      </div>

      {/* Command Strip */}
      <CommandStrip
        counts={commandCounts}
        activeFilter={dashboardFilter}
        onFilterChange={setDashboardFilter}
      />

      {/* Action Queue */}
      <div id="action-queue">
        <ActionQueue leads={filteredLeads} onLeadUpdated={loadData} />
      </div>

      {/* AI Focus */}
      <AIFocusPanel topItem={topFocusItem} />

      {/* Lead Table */}
      <LeadTable leads={filteredLeads} isLoading={isLoading} onLeadUpdated={loadData} />
    </div>
  );
}
