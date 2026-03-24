import { useEffect, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Target, TrendingUp, Shield, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { getLeadIntelligence } from "@/lib/supabaseQueries";
import type { LeadIntelligence } from "@/lib/supabaseQueries";
import type { ConversationAnalysis } from "@/lib/inboxQueries";
import type { LeadSnapshot } from "./LeadContextPanel";

type Props = {
  analysis: ConversationAnalysis | null;
  lead: LeadSnapshot | null;
  allAnalysis: ConversationAnalysis[];
};

export function UnifiedInsightsPanel({ analysis, lead, allAnalysis }: Props) {
  const [intelligence, setIntelligence] = useState<LeadIntelligence | null>(null);

  // Load canonical intelligence when lead is linked
  const loadIntelligence = useCallback(async () => {
    if (!lead?.id) return;
    const data = await getLeadIntelligence(lead.id);
    setIntelligence(data);
  }, [lead?.id]);

  useEffect(() => {
    loadIntelligence();
  }, [loadIntelligence]);

  // Use canonical intelligence if available, fall back to conversation-level data
  const objections = intelligence?.objections_json?.length
    ? intelligence.objections_json
    : [...new Set(allAnalysis.flatMap((a) => {
        const f = (a.extracted_features ?? {}) as Record<string, any>;
        return f?.objections ?? [];
      }))];

  const buyingSignals = intelligence?.engagement_signals_json?.channel_activity
    ? [] // buying signals are within engagement_signals_json for canonical
    : [...new Set(allAnalysis.flatMap((a) => {
        const f = (a.extracted_features ?? {}) as Record<string, any>;
        return f?.buying_signals ?? [];
      }))];

  const risks = intelligence?.risks_json?.length
    ? intelligence.risks_json
    : (lead?.risks_json as any[]) ?? [];

  const milestones = intelligence?.milestones_json?.length
    ? intelligence.milestones_json
    : (lead?.milestones_json as any[]) ?? [];

  const summaryText = intelligence?.summary_text || analysis?.summary_text;

  const hasContent = objections.length > 0 || buyingSignals.length > 0 || risks.length > 0 || milestones.length > 0 || summaryText;

  if (!hasContent) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground py-8">
        <Sparkles className="h-5 w-5 mx-auto mb-2 opacity-50" />
        <p>No insights yet</p>
        <p className="text-xs mt-1">Insights populate after conversation analysis runs.</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Summary */}
      {summaryText && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Summary</span>
          <p className="text-xs text-foreground leading-relaxed">{summaryText}</p>
        </div>
      )}

      {/* Next Step (from canonical intelligence) */}
      {intelligence?.recommended_next_step && (
        <>
          <Separator />
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Next Step</span>
            <p className="text-xs text-foreground font-medium">{intelligence.recommended_next_step}</p>
            {intelligence.next_step_reason && (
              <p className="text-[10px] text-muted-foreground mt-0.5">{intelligence.next_step_reason}</p>
            )}
          </div>
        </>
      )}

      {/* Risks */}
      {risks.length > 0 && (
        <>
          <Separator />
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> Risks ({risks.length})
            </span>
            <div className="space-y-1 mt-1.5">
              {risks.slice(0, 5).map((r: any, i: number) => (
                <p key={i} className="text-xs text-foreground bg-destructive/5 rounded px-2 py-1">
                  {typeof r === "string" ? r : r.issue ?? r.label ?? r.description ?? JSON.stringify(r)}
                </p>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Milestones */}
      {milestones.length > 0 && (
        <>
          <Separator />
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
              <Target className="h-3 w-3" /> Milestones ({milestones.length})
            </span>
            <div className="space-y-1 mt-1.5">
              {milestones.slice(0, 5).map((m: any, i: number) => (
                <p key={i} className="text-xs text-foreground bg-primary/5 rounded px-2 py-1">
                  {typeof m === "string" ? m : m.description ?? m.label ?? JSON.stringify(m)}
                </p>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Objections */}
      {objections.length > 0 && (
        <>
          <Separator />
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
              <Shield className="h-3 w-3" /> Objections ({objections.length})
            </span>
            <div className="space-y-1 mt-1.5">
              {objections.map((obj: any, i: number) => (
                <p key={i} className="text-xs text-foreground bg-destructive/5 rounded px-2 py-1">
                  {typeof obj === "string" ? obj : JSON.stringify(obj)}
                </p>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Buying Signals (fallback from conversation analysis) */}
      {buyingSignals.length > 0 && (
        <>
          <Separator />
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Buying Signals ({buyingSignals.length})
            </span>
            <div className="space-y-1 mt-1.5">
              {buyingSignals.map((sig: any, i: number) => (
                <p key={i} className="text-xs text-foreground bg-[hsl(var(--success)/0.05)] rounded px-2 py-1">
                  {sig}
                </p>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
