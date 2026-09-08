import { useState, useEffect } from "react";
import {
  LeadDetail, updateLeadMilestoneStatus, deleteLeadMilestone, replaceLeadMilestonesDeduped,
  getLeadIntelligence, triggerIntelligenceRecompute,
} from "@/lib/supabaseQueries";
import { useAITask } from "@/hooks/useAITask";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Loader2, CheckCircle, AlertTriangle, Trash2, Sparkles, Brain } from "lucide-react";


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


/** Raw deal-factor enums → sentences a rep would say. Unknown/empty values are
 *  dropped rather than shown as a bare enum. */
function dealFactorSentences(f: DealFactors): string[] {
  const out: string[] = [];
  const humanise = (v: string) => v.replace(/_/g, " ").trim();

  const PROCUREMENT: Record<string, string> = {
    not_started: "Buying process hasn't started on their side.",
    early: "They're at the very start of their buying process.",
    in_progress: "Their buying process is under way.",
    legal_review: "It's with their legal team.",
    security_review: "It's with their security team.",
    contract_sent: "The contract is with them.",
    complete: "Their buying process is done.",
  };
  const LATENCY: Record<string, string> = {
    fast: "They reply quickly.",
    immediate: "They reply almost straight away.",
    medium: "They take a few days to reply.",
    moderate: "They take a few days to reply.",
    slow: "They're slow to reply.",
    none: "They haven't replied yet.",
  };

  if (f.engagement_level) out.push(`Engagement: ${humanise(f.engagement_level)}.`);
  if (f.reply_latency) out.push(LATENCY[f.reply_latency] ?? `They reply ${humanise(f.reply_latency)}.`);
  const dm = f.decision_maker_involved;
  if (dm !== undefined && dm !== null && dm !== "") {
    const yes = dm === true || dm === "true" || dm === "yes";
    out.push(yes ? "The decision maker is in the conversation." : "The decision maker isn't in the conversation yet.");
  }
  if (f.identified_champion) out.push(`Champion: ${f.identified_champion}.`);
  if (f.budget_status) out.push(`Budget: ${humanise(f.budget_status)}.`);
  if (f.timeline) out.push(`Timing: ${humanise(f.timeline)}.`);
  if (f.procurement_stage) out.push(PROCUREMENT[f.procurement_stage] ?? `Buying process: ${humanise(f.procurement_stage)}.`);
  if (f.overall_outlook) out.push(`Overall this looks ${humanise(f.overall_outlook)}.`);
  return out;
}

export default function RecommendationsTab({ lead, onUpdate }: RecommendationsTabProps) {
  const [isCleaning, setIsCleaning] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const { runTask } = useAITask();

  // Canonical intelligence source
  const [intelligence, setIntelligence] = useState<any>(null);
  useEffect(() => {
    getLeadIntelligence(lead.id).then(setIntelligence).catch(console.error);
  }, [lead.id]);

  // Manual recompute lives here (Deep Analysis) since Unit 3 removed the
  // duplicate "Run Analysis" control from the compact Intelligence card — this
  // is the kept, reachable path for a rep to re-run analysis on a stale lead.
  const lastComputedAt = intelligence?.last_computed_at as string | null | undefined;
  const handleRecompute = async () => {
    setIsAnalyzing(true);
    try {
      toast.info("Running intelligence recompute...");
      const result = await triggerIntelligenceRecompute(lead.id);
      if (!result.ok) {
        toast.error(result.error || "Recompute failed");
      } else {
        toast.success("Intelligence updated!");
        const updated = await getLeadIntelligence(lead.id);
        setIntelligence(updated);
        onUpdate();
      }
    } catch (err: any) {
      toast.error(err.message || "Recompute failed");
    } finally {
      setIsAnalyzing(false);
    }
  };

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

  // Keyed by description text, not array index — the recompute reorders the
  // list, so an index captured at render time can point at a different row.
  const reloadIntelligence = async () => setIntelligence(await getLeadIntelligence(lead.id));

  const handleDeleteMilestone = async (description: string) => {
    try {
      await deleteLeadMilestone(lead.id, description);
      toast.success("Milestone deleted");
      await reloadIntelligence();
      onUpdate();
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete milestone");
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
          const removed = await replaceLeadMilestonesDeduped(lead.id, deduped.unique_milestones);
          if (removed > 0) {
            toast.success(`Removed ${removed} duplicate${removed !== 1 ? "s" : ""}`);
            await reloadIntelligence();
            onUpdate();
          } else {
            toast.info("No duplicates found");
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
      {/* Run Analysis — relocated here from the Intelligence card (Unit 3). */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {lastComputedAt
            ? `Checked ${formatDistanceToNow(new Date(lastComputedAt), { addSuffix: true })}`
            : "Not checked yet"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1"
          onClick={handleRecompute}
          disabled={isAnalyzing}
        >
          {isAnalyzing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Brain className="h-3 w-3" />}
          {isAnalyzing ? "Updating…" : "Update"}
        </Button>
      </div>

      {/* Deal read — plain sentences. Unit L2 replaced the raw enum badges
          (procurement_stage / reply_latency / decision_maker_involved) with
          language a rep would actually say out loud. */}
      {dealFactors && (
        <Card>
          <CardHeader>
            <CardTitle>How this deal reads</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm text-foreground">
              {dealFactorSentences(dealFactors).map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
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
              What we agreed to do
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
              <p className="text-muted-foreground text-sm">Nothing agreed yet</p>
            ) : (
              <div className="space-y-3">
                {milestones.map((m, i) => (
                  <div key={`${i}-${m.description}`} className="flex items-start gap-3 p-2 rounded border bg-muted/30 group">
                    <Checkbox
                      id={`rec-milestone-${i}`}
                      checked={m.status === "completed"}
                      onCheckedChange={async (checked) => {
                        try {
                          await updateLeadMilestoneStatus(lead.id, m.description, !!checked);
                          toast.success(`Milestone ${checked ? "completed" : "reopened"}`);
                          // Reload intelligence to reflect canonical update
                          await reloadIntelligence();
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
                      onClick={() => handleDeleteMilestone(m.description)}
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
              What could go wrong
            </CardTitle>
          </CardHeader>
          <CardContent>
            {risks.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing worrying so far</p>
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
