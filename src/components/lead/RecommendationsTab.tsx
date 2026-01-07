import { useState } from "react";
import type { Json } from "@/integrations/supabase/types";
import { LeadDetail, getLeadInteractions } from "@/lib/supabaseQueries";
import { useAITask } from "@/hooks/useAITask";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, Brain, CheckCircle, AlertTriangle, Target } from "lucide-react";

interface RecommendationsTabProps {
  lead: LeadDetail;
  onUpdate: () => void;
}

interface Milestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
  evidence: string;
}

interface Risk {
  issue: string;
  level: "low" | "medium" | "high";
  evidence: string;
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

interface Recommendation {
  title: string;
  why: string;
  action: string;
  priority: string;
}

interface NextStep {
  title: string;
  why: string;
  action: string;
}

function extractJsonFromAIContent(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

// Clean email body by removing signatures and quoted replies
function cleanEmailBody(body: string): string {
  return body
    .split(/\n-{2,}|\nOn .* wrote:|\nFrom:|\n>|\nSent from/)[0] // Stop at signature/quote markers
    .slice(0, 300) // Limit to 300 chars
    .trim();
}

// Build interaction text with limited data to reduce payload size
function buildInteractionsText(
  interactions: { type: string; subject: string | null; body_text: string }[],
  limit: number = 15
): string {
  return interactions
    .slice(0, limit) // Take most recent interactions
    .map((i) => `[${i.type}] ${i.subject || ""}: ${cleanEmailBody(i.body_text)}`)
    .join("\n---\n");
}

export default function RecommendationsTab({ lead, onUpdate }: RecommendationsTabProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const { runTask } = useAITask();

  const milestones: Milestone[] = lead.milestones_json ? (lead.milestones_json as unknown as Milestone[]) : [];
  const risks: Risk[] = lead.risks_json ? (lead.risks_json as unknown as Risk[]) : [];
  const dealFactors: DealFactors | null = lead.deal_factors_json ? (lead.deal_factors_json as unknown as DealFactors) : null;

  const buildLeadContext = () => {
    return `Name: ${lead.name}
Company: ${lead.company}
Email: ${lead.email}
Strategy: ${lead.strategy}
Status: ${lead.status}
${lead.personal_notes ? `Notes: ${lead.personal_notes}` : ""}`;
  };

  const analyzeDeal = async () => {
    setIsAnalyzing(true);
    let hasAnyData = false;
    
    try {
      const interactions = await getLeadInteractions(lead.id);
      
      if (interactions.length === 0) {
        toast.warning("No interactions found. Add emails or notes before analyzing.");
        setIsAnalyzing(false);
        return;
      }
      
      // Limit to 15 most recent interactions with cleaned body text
      const interactionsText = buildInteractionsText(interactions, 15);
      console.log("[AI Analysis] Payload size:", interactionsText.length, "chars");

      // Step 1: Extract milestones and risks
      toast.info("Extracting milestones and risks...");
      const milestonesResult = await runTask("extract_milestones_risks", {
        lead_context: buildLeadContext(),
        interactions_text: interactionsText,
        lead_id: lead.id,
      });

      let parsedMilestones: { milestones: Milestone[]; risks: Risk[] } = { milestones: [], risks: [] };
      if (milestonesResult.ok && milestonesResult.content) {
        try {
          const extracted = extractJsonFromAIContent(milestonesResult.content);
          console.log("[AI Analysis] Milestones raw:", extracted);
          parsedMilestones = JSON.parse(extracted);
          hasAnyData = true;
        } catch (e) {
          console.error("[AI Analysis] Milestones parse error:", e, milestonesResult.content);
          toast.error("Couldn't parse milestones/risks result");
        }
      } else if (!milestonesResult.ok) {
        toast.error(milestonesResult.error || "Failed to extract milestones");
      }

      // Step 2: Extract deal factors
      toast.info("Analyzing deal factors...");
      const factorsResult = await runTask("extract_deal_factors", {
        lead_context: buildLeadContext(),
        interactions_text: interactionsText,
        lead_id: lead.id,
      });

      let parsedFactors: DealFactors | null = null;
      if (factorsResult.ok && factorsResult.content) {
        try {
          const extracted = extractJsonFromAIContent(factorsResult.content);
          console.log("[AI Analysis] Deal factors raw:", extracted);
          parsedFactors = JSON.parse(extracted);
          hasAnyData = true;
        } catch (e) {
          console.error("[AI Analysis] Deal factors parse error:", e, factorsResult.content);
          toast.error("Couldn't parse deal factors result");
        }
      } else if (!factorsResult.ok) {
        toast.error(factorsResult.error || "Failed to extract deal factors");
      }

      // Step 3: Get recommendations
      toast.info("Generating recommendations...");
      const recsResult = await runTask("recommend_next_steps", {
        lead_context: buildLeadContext(),
        milestones_risks_json: JSON.stringify(parsedMilestones),
        deal_factors_json: JSON.stringify(parsedFactors),
        lead_id: lead.id,
      });

      let parsedRecs: { recommendations: Recommendation[]; best_next_step: NextStep | null } = {
        recommendations: [],
        best_next_step: null,
      };
      if (recsResult.ok && recsResult.content) {
        try {
          const extracted = extractJsonFromAIContent(recsResult.content);
          console.log("[AI Analysis] Recommendations raw:", extracted);
          parsedRecs = JSON.parse(extracted);
          hasAnyData = true;
        } catch (e) {
          console.error("[AI Analysis] Recommendations parse error:", e, recsResult.content);
          toast.error("Couldn't parse recommendations result");
        }
      } else if (!recsResult.ok) {
        toast.error(recsResult.error || "Failed to get recommendations");
      }

      // Only update lead if we have at least some valid data
      if (!hasAnyData) {
        toast.error("Analysis failed - no valid data received from AI");
        setIsAnalyzing(false);
        return;
      }

      // Merge milestones: keep existing + add new (deduplicate by description)
      const existingMilestones: Milestone[] = lead.milestones_json
        ? (lead.milestones_json as unknown as Milestone[])
        : [];
      const mergedMilestones = [...existingMilestones];
      for (const newMs of parsedMilestones.milestones) {
        const exists = mergedMilestones.some(
          (m) => m.description.toLowerCase() === newMs.description.toLowerCase()
        );
        if (!exists) {
          mergedMilestones.push(newMs);
        }
      }

      // Merge risks: keep existing + add new (deduplicate by issue)
      const existingRisks: Risk[] = lead.risks_json
        ? (lead.risks_json as unknown as Risk[])
        : [];
      const mergedRisks = [...existingRisks];
      for (const newRisk of parsedMilestones.risks) {
        const exists = mergedRisks.some(
          (r) => r.issue.toLowerCase() === newRisk.issue.toLowerCase()
        );
        if (!exists) {
          mergedRisks.push(newRisk);
        }
      }

      // Update lead with merged analysis
      const { error: updateError } = await supabase
        .from("leads")
        .update({
          milestones_json: mergedMilestones as unknown as Json,
          risks_json: mergedRisks as unknown as Json,
          deal_factors_json: parsedFactors as unknown as Json,
          next_step: parsedRecs.best_next_step?.title || null,
          next_step_reason: parsedRecs.best_next_step?.why || null,
          deal_outlook: parsedFactors?.overall_outlook || null,
          last_ai_run_at: new Date().toISOString(),
        })
        .eq("id", lead.id);

      if (updateError) {
        console.error("[AI Analysis] DB update error:", updateError);
        toast.error("Failed to save analysis results");
      } else {
        toast.success("Analysis complete!");
        onUpdate();
      }
    } catch (err) {
      toast.error("Analysis failed");
      console.error("[AI Analysis] Error:", err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const getRiskColor = (level: string) => {
    switch (level) {
      case "high":
        return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      case "medium":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
      default:
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "P0":
        return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      case "P1":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
      default:
        return "bg-secondary text-secondary-foreground";
    }
  };

  return (
    <div className="space-y-6">
      {/* Analyze Button */}
      <Card>
        <CardHeader>
          <CardTitle>AI Deal Analysis</CardTitle>
          <CardDescription>
            Analyze interactions to extract milestones, identify risks, and get next step recommendations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={analyzeDeal} disabled={isAnalyzing}>
            {isAnalyzing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Brain className="h-4 w-4 mr-2" />
            )}
            {isAnalyzing ? "Analyzing..." : "Analyze Deal"}
          </Button>
          {lead.last_ai_run_at && (
            <p className="text-xs text-muted-foreground mt-2">
              Last analyzed: {new Date(lead.last_ai_run_at).toLocaleString()}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Next Step */}
      {lead.next_step && (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              Recommended Next Step
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium text-lg">{lead.next_step}</p>
            {lead.next_step_reason && (
              <p className="text-muted-foreground mt-2">{lead.next_step_reason}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Deal Factors */}
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
                <Badge variant="outline">
                  {String(dealFactors.decision_maker_involved)}
                </Badge>
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

      <div className="grid md:grid-cols-2 gap-6">
        {/* Milestones */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              Milestones
            </CardTitle>
          </CardHeader>
          <CardContent>
            {milestones.length === 0 ? (
              <p className="text-muted-foreground text-sm">No milestones extracted yet</p>
            ) : (
              <div className="space-y-3">
                {milestones.map((m, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge variant={m.status === "completed" ? "default" : "secondary"}>
                      {m.status}
                    </Badge>
                    <div>
                      <p className="text-sm">{m.description}</p>
                      {m.date && (
                        <p className="text-xs text-muted-foreground">{m.date}</p>
                      )}
                    </div>
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
