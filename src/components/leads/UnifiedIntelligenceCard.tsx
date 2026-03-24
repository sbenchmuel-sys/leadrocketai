import { useState, useEffect, useCallback } from "react";
import type { Json } from "@/integrations/supabase/types";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { getLeadIntelligence, triggerIntelligenceRecompute } from "@/lib/supabaseQueries";
import type { LeadIntelligence } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Loader2, Brain, AlertTriangle, Target, CheckCircle, Shield, Zap, ExternalLink, TrendingUp, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

// ── Types ──────────────────────────────────────────────────────────────

interface Milestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
  evidence?: string;
}

interface Risk {
  issue: string;
  level: "low" | "medium" | "high";
  evidence?: string;
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

interface LeadSignal {
  id: string;
  signal_type: string;
  signal_description: string;
  source_url: string | null;
  detected_at: string;
  confidence_score: number | null;
}

// ── Props ──────────────────────────────────────────────────────────────

interface UnifiedIntelligenceCardProps {
  lead: LeadDetail;
  mode?: "compact" | "full";
  onUpdated?: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────

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
  new_partnership: "New Partnership",
  job_change: "Job Change",
  event: "Event",
  press: "Press Coverage",
};

const SIGNAL_TYPE_COLORS: Record<string, string> = {
  funding: "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]",
  hiring: "bg-primary/10 text-primary",
  expansion: "bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))]",
  product_launch: "bg-accent/50 text-accent-foreground",
  new_partnership: "bg-secondary text-secondary-foreground",
  job_change: "bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]",
  event: "bg-muted text-muted-foreground",
  press: "bg-primary/10 text-primary",
};

// ── Component ──────────────────────────────────────────────────────────

export function UnifiedIntelligenceCard({ lead, mode = "full", onUpdated }: UnifiedIntelligenceCardProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [intelligence, setIntelligence] = useState<LeadIntelligence | null>(null);
  const [enrichment, setEnrichment] = useState<EnrichmentRow | null | undefined>(undefined);
  const [leadSignals, setLeadSignals] = useState<LeadSignal[]>([]);

  const isCompact = mode === "compact";
  const maxItems = isCompact ? 3 : 10;

  // Use intelligence data if available, fall back to lead fields
  const milestones: Milestone[] = intelligence?.milestones_json?.length
    ? (intelligence.milestones_json as Milestone[])
    : lead.milestones_json
      ? (lead.milestones_json as unknown as Milestone[])
      : [];

  const risks: Risk[] = intelligence?.risks_json?.length
    ? (intelligence.risks_json as Risk[])
    : lead.risks_json
      ? (lead.risks_json as unknown as Risk[])
      : [];

  const objections: string[] = intelligence?.objections_json?.length
    ? intelligence.objections_json
    : (lead as any).objections_json ?? [];

  const nextStep = intelligence?.recommended_next_step || lead.next_step;
  const nextStepReason = intelligence?.next_step_reason || lead.next_step_reason;
  const summaryText = intelligence?.summary_text || null;
  const lastComputedAt = intelligence?.last_computed_at || lead.last_ai_run_at;

  // ── Load intelligence ──
  const loadIntelligence = useCallback(async () => {
    const data = await getLeadIntelligence(lead.id);
    setIntelligence(data);
  }, [lead.id]);

  // ── Load enrichment signals ──
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

  // ── Load lead signals ──
  const loadLeadSignals = useCallback(async () => {
    try {
      const { data } = await supabase
        .from("lead_signals")
        .select("id, signal_type, signal_description, source_url, detected_at, confidence_score")
        .eq("lead_id", lead.id)
        .order("detected_at", { ascending: false })
        .limit(10);
      setLeadSignals((data as LeadSignal[]) ?? []);
    } catch {
      setLeadSignals([]);
    }
  }, [lead.id]);

  useEffect(() => {
    loadIntelligence();
    loadEnrichment();
    loadLeadSignals();
  }, [loadIntelligence, loadEnrichment, loadLeadSignals]);

  const signals: EnrichmentSignal[] = enrichment?.signals ?? [];
  const enrichmentExpired = enrichment === null || (enrichment && new Date(enrichment.expires_at) < new Date());
  const showEnrichButton = enrichment === null || enrichmentExpired;

  // ── Enrich handler ──
  const handleEnrich = async (force = false) => {
    setIsEnriching(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) { toast.error("Please log in to enrich."); return; }

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
      toast.error(err.message || "Enrichment failed");
    } finally {
      setIsEnriching(false);
    }
  };

  // ── Recompute intelligence handler ──
  const handleRecompute = async () => {
    setIsAnalyzing(true);
    try {
      toast.info("Running intelligence recompute...");
      const result = await triggerIntelligenceRecompute(lead.id);
      if (!result.ok) {
        toast.error(result.error || "Recompute failed");
      } else {
        toast.success("Intelligence updated!");
        await loadIntelligence();
        onUpdated?.();
      }
    } catch (err: any) {
      toast.error(err.message || "Recompute failed");
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <Card className={cn(isCompact ? "border-0 shadow-none" : "")}>
      {!isCompact && (
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Brain className="h-4 w-4 text-primary" />
              Intelligence
            </CardTitle>
            <div className="flex items-center gap-2">
              {lastComputedAt && (
                <span className="text-[10px] text-muted-foreground">
                  {formatDistanceToNow(new Date(lastComputedAt), { addSuffix: true })}
                </span>
              )}
            </div>
          </div>
        </CardHeader>
      )}

      <CardContent className={cn(isCompact ? "p-0" : "", "space-y-4")}>
        {/* Summary */}
        {summaryText && (
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Summary</span>
            <p className="text-xs text-foreground leading-relaxed">{summaryText}</p>
          </div>
        )}

        {/* Next Step */}
        {nextStep && (
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">
              Best Next Step
            </span>
            <p className={cn("font-medium text-foreground", isCompact ? "text-sm" : "text-base")}>
              {nextStep}
            </p>
            {nextStepReason && (
              <p className="text-xs text-muted-foreground mt-1">{nextStepReason}</p>
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

        {/* Objections */}
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

        {/* Lead Sales Signals */}
        {leadSignals.length > 0 && (
          <>
            <Separator />
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> Sales Signals ({leadSignals.length})
              </span>
              <div className="space-y-1.5 mt-1">
                {leadSignals.slice(0, maxItems).map((s) => (
                  <div key={s.id} className="flex items-start gap-2">
                    <Badge className={cn("text-[10px] shrink-0", SIGNAL_TYPE_COLORS[s.signal_type] ?? "bg-muted text-muted-foreground")}>
                      {SIGNAL_LABELS[s.signal_type] ?? s.signal_type}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-xs text-foreground">{s.signal_description}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-muted-foreground">
                          {formatDistanceToNow(new Date(s.detected_at), { addSuffix: true })}
                        </span>
                        {s.source_url && (
                          <a href={s.source_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline flex items-center gap-0.5">
                            <ExternalLink className="h-2.5 w-2.5" /> Source
                          </a>
                        )}
                        {s.confidence_score != null && (
                          <span className="text-[10px] text-muted-foreground">{Math.round(s.confidence_score * 100)}%</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {leadSignals.length > maxItems && (
                  <p className="text-[10px] text-muted-foreground">+{leadSignals.length - maxItems} more</p>
                )}
              </div>
            </div>
          </>
        )}

        {/* Company Signals */}
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

        {/* Enrich button */}
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

        {/* Footer: Last run + Recompute button */}
        <Separator />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {lastComputedAt
              ? `Analyzed ${formatDistanceToNow(new Date(lastComputedAt), { addSuffix: true })}`
              : "Never analyzed"}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={handleRecompute}
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
