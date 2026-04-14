import { useState, useEffect } from "react";
import type { Json } from "@/integrations/supabase/types";
import { LeadDetail, updateLeadMilestoneStatus, getLeadIntelligence } from "@/lib/supabaseQueries";
import { useAITask } from "@/hooks/useAITask";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Loader2, CheckCircle, AlertTriangle, Trash2, Sparkles } from "lucide-react";


interface RecommendationsTabProps {
  lead: LeadDetail;
  onUpdate: () => void;
}

interface Milestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
  evidence: string;
  evidence_ids?: string[];
  source_types?: string[];
  completedAt?: string;
}

interface Risk {
  issue: string;
  level: "low" | "medium" | "high";
  evidence: string;
  evidence_ids?: string[];
  source_types?: string[];
}

interface DealFactors {
  engagement_level: string;
  reply_latency: string;
  decision_maker_involved: boolean | string;
  identified_champion: string;
  budget_status: string;
  timeline: string;
  procurement_stage: string;
  overall_outlook: string;
  reasoning: string;
}

function extractJsonFromAIContent(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

export default function RecommendationsTab({ lead, onUpdate }: RecommendationsTabProps) {
  const [isCleaning, setIsCleaning] = useState(false);
  const { runTask } = useAITask();

  // Canonical intelligence source
  const [intelligence, setIntelligence] = useState<any>(null);
  useEffect(() => {
    getLeadIntelligence(lead.id).then(setIntelligence).catch(console.error);
  }, [lead.id]);

  const hasCanonical = intelligence !== null;

  // Prefer canonical intelligence, fall back to legacy lead fields
  const milestones: Milestone[] = hasCanonical
    ? (intelligence.milestones_json as unknown as Milestone[] ?? [])
    : (lead.milestones_json ? (lead.milestones_json as unknown as Milestone[]) : []);

  const risks: Risk[] = hasCanonical
    ? (intelligence.risks_json as unknown as Risk[] ?? [])
    : (lead.risks_json ? (lead.risks_json as unknown as Risk[]) : []);

  const dealFactors: DealFactors | null = hasCanonical
    ? (intelligence.deal_factors_json as unknown as DealFactors ?? null)
    : (lead.deal_factors_json ? (lead.deal_factors_json as unknown as DealFactors) : null);

  const getRiskColor = (level: string) => {
    switch (level) {
      case "high": return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      case "medium": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
      default: return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
    }
  };

  const handleDeleteMilestone = async (index: number) => {
    const updated = milestones.filter((_, i) => i !== index);
    const { error } = await supabase
      .from("leads")
      .update({ milestones_json: updated as unknown as Json })
      .eq("id", lead.id);
    if (error) {
      toast.error("Failed to delete milestone");
    } else {
      toast.success("Milestone deleted");
      onUpdate();
    }
  };

  const handleCleanupDuplicates = async () => {
    if (milestones.length < 2) {
      toast.info("Not enough milestones to deduplicate");
      return;
    }
    setIsCleaning(true);
    try {
      const result = await runTask("dedupe_milestones", {
        milestones_json: JSON.stringify(milestones),
      });
      if (result.ok && result.content) {
        const deduped = JSON.parse(extractJsonFromAIContent(result.content));
        if (deduped.unique_milestones?.length > 0) {
          const { error } = await supabase
            .from("leads")
            .update({ milestones_json: deduped.unique_milestones as unknown as Json })
            .eq("id", lead.id);
          if (error) {
            toast.error("Failed to save cleaned milestones");
          } else {
            toast.success(`Removed ${deduped.duplicates_removed} duplicate${deduped.duplicates_removed !== 1 ? "s" : ""}`);
            onUpdate();
          }
        } else {
          toast.info("No duplicates found");
        }
      } else {
        toast.error(result.error || "Failed to clean duplicates");
      }
    } catch (err) {
      console.error(err);
      toast.error("Cleanup failed");
    } finally {
      setIsCleaning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Deal Factors (unique to Deep Analysis — not shown elsewhere) */}
      {dealFactors && (
        <Card>
          <CardHeader>
            <CardTitle>Deal Factors</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Engagement</p>
                <Badge variant="outline">{dealFactors.engagement_level}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Reply Speed</p>
                <Badge variant="outline">{dealFactors.reply_latency}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Budget</p>
                <Badge variant="outline">{dealFactors.budget_status}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Timeline</p>
                <Badge variant="outline">{dealFactors.timeline}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Procurement</p>
                <Badge variant="outline">{dealFactors.procurement_stage}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Champion</p>
                <Badge variant="outline">{dealFactors.identified_champion}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Decision Maker</p>
                <Badge variant="outline">{String(dealFactors.decision_maker_involved)}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Outlook</p>
                <Badge
                  className={
                    dealFactors.overall_outlook === "positive"
                      ? "bg-green-100 text-green-800"
                      : dealFactors.overall_outlook === "negative"
                      ? "bg-red-100 text-red-800"
                      : ""
                  }
                >
                  {dealFactors.overall_outlook}
                </Badge>
              </div>
            </div>
            {dealFactors.reasoning && (
              <p className="text-sm text-muted-foreground mt-4">{dealFactors.reasoning}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Interactive Milestones + Risks (unique interactive controls not in the intelligence card) */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Milestones */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              Milestones
            </CardTitle>
            {milestones.length >= 2 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCleanupDuplicates}
                disabled={isCleaning}
                className="h-8 text-xs"
              >
                {isCleaning ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3 mr-1" />
                )}
                Clean duplicates
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {milestones.length === 0 ? (
              <p className="text-muted-foreground text-sm">No milestones extracted yet</p>
            ) : (
              <div className="space-y-3">
                {milestones.map((m, i) => (
                  <div key={i} className="flex items-start gap-3 p-2 rounded border bg-muted/30 group">
                    <Checkbox
                      id={`rec-milestone-${i}`}
                      checked={m.status === "completed"}
                      onCheckedChange={async (checked) => {
                        try {
                          await updateLeadMilestoneStatus(lead.id, i, !!checked);
                          toast.success(`Milestone ${checked ? "completed" : "reopened"}`);
                          // Reload intelligence to reflect canonical update
                          const updated = await getLeadIntelligence(lead.id);
                          setIntelligence(updated);
                          onUpdate();
                        } catch (err) {
                          console.error(err);
                          toast.error("Failed to update milestone");
                        }
                      }}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <p className={`text-sm ${m.status === "completed" ? "line-through text-muted-foreground" : ""}`}>
                        {m.description}
                      </p>
                      {m.date && (
                        <p className="text-xs text-muted-foreground mt-1">{m.date}</p>
                      )}
                    </div>
                    {m.status === "completed" ? (
                      <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200">
                        Done
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">Pending</Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleDeleteMilestone(i)}
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Risks */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
              Risks
            </CardTitle>
          </CardHeader>
          <CardContent>
            {risks.length === 0 ? (
              <p className="text-muted-foreground text-sm">No risks identified</p>
            ) : (
              <div className="space-y-3">
                {risks.map((r, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge className={getRiskColor(r.level)}>{r.level}</Badge>
                    <div>
                      <p className="text-sm">{r.issue}</p>
                      <p className="text-xs text-muted-foreground">{r.evidence}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
