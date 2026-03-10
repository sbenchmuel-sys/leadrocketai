import { useState, useEffect, useCallback } from "react";
import type { Json } from "@/integrations/supabase/types";
import { getLeadInteractions } from "@/lib/supabaseQueries";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { useAITask } from "@/hooks/useAITask";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Loader2, Brain, AlertTriangle, Target, CheckCircle, Shield, Zap, ExternalLink, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

// ── Types ──────────────────────────────────────────────────────────────

interface Milestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
  evidence: string;
  completedAt?: string;
}

interface Risk {
  issue: string;
  level: "low" | "medium" | "high";
  evidence: string;
}

interface EnrichmentSignal {
  signal: string;
  source: string;
  snippet?: string;
}

interface EnrichmentRow {
  id: string;
  signals: EnrichmentSignal[];
  expires_at: string;
  created_at: string;
}

// ── Props ──────────────────────────────────────────────────────────────

interface UnifiedIntelligenceCardProps {
  lead: LeadDetail;
  mode?: "compact" | "full";
  onUpdated?: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractJsonFromAIContent(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function cleanEmailBody(body: string): string {
  return body
    .split(/\n-{2,}|\nOn .* wrote:|\nFrom:|\n>|\nSent from/)[0]
    .slice(0, 300)
    .trim();
}

function buildInteractionsText(
  interactions: { type: string; subject: string | null; body_text: string }[],
  limit = 15
): string {
  return interactions
    .slice(0, limit)
    .map((i) => `[${i.type}] ${i.subject || ""}: ${cleanEmailBody(i.body_text)}`)
    .join("\n---\n");
}

const RISK_COLORS: Record<string, string> = {
  high: "bg-destructive/10 text-destructive",
  medium: "bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]",
  low: "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]",
};

const SIGNAL_LABELS: Record<string, string> = {
  funding: "Funding Activity",
  hiring: "Hiring Signal",
  expansion: "Expansion",
  product_launch: "Product Launch",
  leadership_change: "Leadership Change",
  partnership: "Partnership",
  news: "In the News",
};

// ── Component ──────────────────────────────────────────────────────────

export function UnifiedIntelligenceCard({ lead, mode = "full", onUpdated }: UnifiedIntelligenceCardProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [enrichment, setEnrichment] = useState<EnrichmentRow | null | undefined>(undefined); // undefined = not loaded
  const { runTask } = useAITask();

  const milestones: Milestone[] = lead.milestones_json ? (lead.milestones_json as unknown as Milestone[]) : [];
  const risks: Risk[] = lead.risks_json ? (lead.risks_json as unknown as Risk[]) : [];
  const objections: string[] = (lead as any).objections_json
    ? ((lead as any).objections_json as string[])
    : [];
  const isCompact = mode === "compact";
  const maxItems = isCompact ? 3 : 10;

  // ── Load enrichment signals (once per lead) ──
  const loadEnrichment = useCallback(async () => {
    try {
      const { data } = await supabase
        .from("entity_enrichment")
        .select("id, signals, expires_at, created_at")
        .eq("lead_id", lead.id)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      setEnrichment(data as unknown as EnrichmentRow | null);
    } catch {
      setEnrichment(null);
    }
  }, [lead.id]);

  useEffect(() => {
    loadEnrichment();
  }, [loadEnrichment]);

  const signals: EnrichmentSignal[] = enrichment?.signals ?? [];
  const enrichmentExpired = enrichment === null || (enrichment && new Date(enrichment.expires_at) < new Date());
  const showEnrichButton = enrichment === null || enrichmentExpired;

  // ── Enrich handler ──
  const handleEnrich = async (force = false) => {
    setIsEnriching(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        toast.error("Please log in to enrich.");
        return;
      }

      const res = await fetch(`${supabaseUrl}/functions/v1/enrich-company-search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ lead_id: lead.id, company: lead.company, force }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Enrichment failed (${res.status})`);
      }

      toast.success("Company signals updated");
      await loadEnrichment();
    } catch (err: any) {
      console.error("[UnifiedIntelligenceCard] Enrich error:", err);
      toast.error(err.message || "Enrichment failed");
    } finally {
      setIsEnriching(false);
    }
  };

  // ── Analyze handler ──
  const analyzeDeal = async () => {
    setIsAnalyzing(true);
    try {
      const interactions = await getLeadInteractions(lead.id);
      if (interactions.length === 0) {
        toast.warning("No interactions found. Add emails or notes before analyzing.");
        return;
      }

      const interactionsText = buildInteractionsText(interactions, 15);
      toast.info("Running deep analysis...");

      const deepResult = await runTask("lead_deep_analysis", {
        lead_context: `Name: ${lead.name}\nCompany: ${lead.company}\nEmail: ${lead.email}\nStrategy: ${lead.strategy}\nStatus: ${lead.status}\n${lead.personal_notes ? `Notes: ${lead.personal_notes}` : ""}`,
        interactions_text: interactionsText,
        lead_id: lead.id,
      });

      if (!deepResult.ok || !deepResult.content) {
        toast.error(deepResult.error || "Failed to run analysis");
        return;
      }

      const extracted = extractJsonFromAIContent(deepResult.content);
      const parsed = JSON.parse(extracted);

      const newMilestones = parsed.milestones || [];
      const newRisks = parsed.risks || [];
      const bestNextStep = parsed.best_next_step || null;
      const dealFactors = parsed.deal_factors || null;

      // Merge milestones with dedupe
      let mergedMilestones = [...milestones, ...newMilestones];
      if (mergedMilestones.length > 1) {
        const dedupeResult = await runTask("dedupe_milestones", {
          milestones_json: JSON.stringify(mergedMilestones),
        });
        if (dedupeResult.ok && dedupeResult.content) {
          try {
            const deduped = JSON.parse(extractJsonFromAIContent(dedupeResult.content));
            if (deduped.unique_milestones?.length > 0) {
              mergedMilestones = deduped.unique_milestones;
            }
          } catch (_) { /* fallback to simple merge */ }
        }
      }

      // Merge risks by issue
      const mergedRisks = [...risks];
      for (const r of newRisks) {
        if (!mergedRisks.some((x) => x.issue.toLowerCase() === r.issue.toLowerCase())) {
          mergedRisks.push(r);
        }
      }

      const { error: updateError } = await supabase
        .from("leads")
        .update({
          milestones_json: mergedMilestones as unknown as Json,
          risks_json: mergedRisks as unknown as Json,
          deal_factors_json: dealFactors as unknown as Json,
          next_step: bestNextStep?.title || null,
          next_step_reason: bestNextStep?.why || null,
          deal_outlook: dealFactors?.overall_outlook || null,
          last_ai_run_at: new Date().toISOString(),
        })
        .eq("id", lead.id);

      if (updateError) {
        toast.error("Failed to save analysis results");
      } else {
        toast.success("Analysis complete!");
        onUpdated?.();
      }
    } catch (err) {
      console.error("[UnifiedIntelligenceCard] Analysis error:", err);
      toast.error("Analysis failed");
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <Card className={cn(isCompact ? "border-0 shadow-none" : "")}>
      {!isCompact && (
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            Intelligence
          </CardTitle>
        </CardHeader>
      )}

      <CardContent className={cn(isCompact ? "p-0" : "", "space-y-4")}>
        {/* Next Step */}
        {lead.next_step && (
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">
              Best Next Step
            </span>
            <p className={cn("font-medium text-foreground", isCompact ? "text-sm" : "text-base")}>
              {lead.next_step}
            </p>
            {lead.next_step_reason && (
              <p className="text-xs text-muted-foreground mt-1">{lead.next_step_reason}</p>
            )}
          </div>
        )}

        {/* Risks */}
        {risks.length > 0 && (
          <>
            <Separator />
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Risks ({risks.length})
              </span>
              <div className="space-y-1.5 mt-1">
                {risks.slice(0, maxItems).map((r, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge className={cn("text-[10px] shrink-0", RISK_COLORS[r.level] ?? RISK_COLORS.low)}>
                      {r.level}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-xs text-foreground">{r.issue}</p>
                      {!isCompact && r.evidence && (
                        <p className="text-[10px] text-muted-foreground">{r.evidence}</p>
                      )}
                    </div>
                  </div>
                ))}
                {risks.length > maxItems && (
                  <p className="text-[10px] text-muted-foreground">+{risks.length - maxItems} more</p>
                )}
              </div>
            </div>
          </>
        )}

        {/* Milestones */}
        {milestones.length > 0 && (
          <>
            <Separator />
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                <Target className="h-3 w-3" /> Milestones ({milestones.length})
              </span>
              <div className="space-y-1.5 mt-1">
                {milestones.slice(0, maxItems).map((m, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <CheckCircle className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", m.status === "completed" ? "text-[hsl(var(--success))]" : "text-muted-foreground")} />
                    <p className={cn("text-xs", m.status === "completed" ? "line-through text-muted-foreground" : "text-foreground")}>
                      {m.description}
                    </p>
                  </div>
                ))}
                {milestones.length > maxItems && (
                  <p className="text-[10px] text-muted-foreground">+{milestones.length - maxItems} more</p>
                )}
              </div>
            </div>
          </>
        )}

        {/* Objections — only if field exists */}
        {objections.length > 0 && (
          <>
            <Separator />
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                <Shield className="h-3 w-3" /> Objections ({objections.length})
              </span>
              <div className="space-y-1 mt-1">
                {objections.slice(0, maxItems).map((obj, i) => (
                  <p key={i} className="text-xs text-foreground bg-destructive/5 rounded px-2 py-1">
                    {typeof obj === "string" ? obj : JSON.stringify(obj)}
                  </p>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Signals summary — only if enrichment exists with signals */}
        {signals.length > 0 && (
          <>
            <Separator />
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                <Zap className="h-3 w-3" /> Company Signals
              </span>
              <div className="space-y-1.5 mt-1">
                {signals.slice(0, isCompact ? 3 : 5).map((s, i) => (
                  <div key={i}>
                    <span className="text-xs font-medium text-foreground">
                      {SIGNAL_LABELS[s.signal] ?? s.signal}
                    </span>
                    {s.snippet && (
                      <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{s.snippet}</p>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-muted-foreground">
                  {enrichment ? `Updated ${formatDistanceToNow(new Date(enrichment.created_at), { addSuffix: true })}` : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[10px] gap-1 text-muted-foreground hover:text-foreground"
                  onClick={() => handleEnrich(true)}
                  disabled={isEnriching}
                >
                  {isEnriching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                  {isEnriching ? "Refreshing…" : "Wrong company? Retry"}
                </Button>
              </div>
            </div>
          </>
        )}

        {/* Enrich button — only when no signals at all */}
        {signals.length === 0 && showEnrichButton && enrichment !== undefined && (
          <>
            <Separator />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">
                {enrichmentExpired && enrichment ? "Enrichment expired" : "No company signals"}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => handleEnrich(false)}
                disabled={isEnriching}
              >
                {isEnriching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                {isEnriching ? "Enriching…" : "Enrich"}
              </Button>
            </div>
          </>
        )}

        {/* Footer: Last run + Analyze button */}
        <Separator />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {lead.last_ai_run_at
              ? `Analyzed ${formatDistanceToNow(new Date(lead.last_ai_run_at), { addSuffix: true })}`
              : "Never analyzed"}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={analyzeDeal}
            disabled={isAnalyzing}
          >
            {isAnalyzing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Brain className="h-3 w-3" />
            )}
            {isAnalyzing ? "Analyzing…" : "Run Analysis"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
