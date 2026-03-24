import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ExternalLink, Brain } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getLeadIntelligence } from "@/lib/supabaseQueries";
import type { LeadIntelligence } from "@/lib/supabaseQueries";
import { STAGE_LABELS, MOTION_LABELS } from "@/lib/dashboardUtils";
import type { DealStage, Motion } from "@/lib/dashboardUtils";

export type LeadSnapshot = {
  id: string;
  name: string;
  company: string;
  email: string;
  stage: string;
  motion: string;
  next_step: string | null;
  next_step_reason: string | null;
  next_action_label: string | null;
  engagement_score: number;
  deal_outlook: string | null;
  risks_json: any;
  milestones_json: any;
  nurture_mode: string;
  nurture_status: string;
};

export async function fetchLeadSnapshot(leadId: string): Promise<LeadSnapshot | null> {
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, name, company, email, stage, motion, next_step, next_step_reason, next_action_label, engagement_score, deal_outlook, risks_json, milestones_json, nurture_mode, nurture_status"
    )
    .eq("id", leadId)
    .maybeSingle();

  if (error || !data) return null;
  return data as LeadSnapshot;
}

type Props = {
  leadId: string | null;
};

export function LeadContextPanel({ leadId }: Props) {
  const [lead, setLead] = useState<LeadSnapshot | null>(null);
  const [intelligence, setIntelligence] = useState<LeadIntelligence | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadData = useCallback(async () => {
    if (!leadId) {
      setLead(null);
      setIntelligence(null);
      return;
    }
    setIsLoading(true);
    try {
      const [snapshot, intel] = await Promise.all([
        fetchLeadSnapshot(leadId),
        getLeadIntelligence(leadId),
      ]);
      setLead(snapshot);
      setIntelligence(intel);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (!leadId) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground py-8">
        <p className="font-medium">Not linked yet</p>
        <p className="text-xs mt-1">This contact isn't associated with a CRM lead.</p>
      </div>
    );
  }

  if (isLoading || !lead) {
    return (
      <div className="p-4 space-y-3 animate-pulse">
        <div className="h-4 bg-muted rounded w-3/4" />
        <div className="h-3 bg-muted rounded w-1/2" />
        <div className="h-3 bg-muted rounded w-2/3" />
      </div>
    );
  }

  const stageLabel = STAGE_LABELS[lead.stage as DealStage] ?? lead.stage;
  const motionLabel = MOTION_LABELS[lead.motion as Motion] ?? lead.motion;
  const hasCanonical = intelligence !== null;

  // When canonical intelligence exists, use it exclusively — do not blend legacy fields.
  const nextStep = hasCanonical ? intelligence.recommended_next_step : lead.next_step;
  const nextStepReason = hasCanonical ? intelligence.next_step_reason : lead.next_step_reason;
  const engagementScore = hasCanonical
    ? (intelligence.engagement_signals_json?.engagement_score ?? lead.engagement_score)
    : lead.engagement_score;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground truncate">{lead.name}</h4>
          <p className="text-xs text-muted-foreground truncate">{lead.company}</p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" asChild>
          <Link to={`/app/lead/${lead.id}`}>
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className="text-[10px]">{stageLabel}</Badge>
        <Badge variant="outline" className="text-[10px]">{motionLabel}</Badge>
        {lead.deal_outlook && (
          <Badge variant="outline" className="text-[10px] capitalize">{lead.deal_outlook}</Badge>
        )}
      </div>

      <Separator />

      <div className="space-y-2">
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-0.5">Engagement</span>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${Math.min(engagementScore, 100)}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground font-medium">{engagementScore}</span>
          </div>
        </div>

        {/* Next step — canonical takes priority */}
        {nextStep && (
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-0.5 flex items-center gap-1">
              <Brain className="h-2.5 w-2.5" /> Next Step
            </span>
            <p className="text-xs text-foreground">{nextStep}</p>
            {nextStepReason && (
              <p className="text-[10px] text-muted-foreground mt-0.5">{nextStepReason}</p>
            )}
          </div>
        )}

        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-0.5">Nurture</span>
          <span className="text-xs text-foreground capitalize">{lead.nurture_status}</span>
        </div>
      </div>
    </div>
  );
}
