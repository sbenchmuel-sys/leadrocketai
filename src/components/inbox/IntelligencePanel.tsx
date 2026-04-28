import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  TrendingUp,
  MessageSquare,
  Shield,
  Target,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchAllContactAnalysis, type ConversationAnalysis } from "@/lib/inboxQueries";

type Props = {
  contactId: string;
  analysis: ConversationAnalysis | null;
};

const sentimentConfig: Record<string, { label: string; color: string; icon: typeof TrendingUp }> = {
  positive: { label: "Positive", color: "text-[hsl(var(--success))]", icon: TrendingUp },
  negative: { label: "Negative", color: "text-destructive", icon: AlertTriangle },
  neutral: { label: "Neutral", color: "text-muted-foreground", icon: MessageSquare },
};

const urgencyConfig: Record<string, { label: string; color: string }> = {
  high: { label: "High", color: "bg-destructive/10 text-destructive border-destructive/20" },
  medium: { label: "Medium", color: "bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.2)]" },
  low: { label: "Low", color: "bg-muted text-muted-foreground border-border" },
};

const riskConfig: Record<string, { label: string; color: string }> = {
  high: { label: "🔴 High Risk", color: "text-destructive" },
  medium: { label: "🟡 Medium Risk", color: "text-[hsl(var(--warning))]" },
  low: { label: "🟢 Low Risk", color: "text-[hsl(var(--success))]" },
};

export function IntelligencePanel({ contactId, analysis }: Props) {
  const [allAnalysis, setAllAnalysis] = useState<ConversationAnalysis[]>([]);

  useEffect(() => {
    fetchAllContactAnalysis(contactId).then(setAllAnalysis).catch(console.error);
  }, [contactId]);

  // Aggregate intelligence across all conversations
  const features = (analysis?.extracted_features ?? {}) as Record<string, any>;
  const allFeatures = allAnalysis.flatMap((a) => {
    const f = (a.extracted_features ?? {}) as Record<string, any>;
    return f ? [f] : [];
  });

  const objections = [...new Set(allFeatures.flatMap((f) => f.objections ?? []))];
  const buyingSignals = [...new Set(allFeatures.flatMap((f) => f.buying_signals ?? []))];
  const ghostingRisk = features.ghosting_risk ?? "low";
  const dealStage = features.deal_stage ?? "unknown";
  const allTopics = [...new Set(allAnalysis.flatMap((a) => a.topics ?? []))];

  const sentimentInfo = sentimentConfig[analysis?.sentiment ?? "neutral"] ?? sentimentConfig.neutral;
  const urgencyInfo = urgencyConfig[analysis?.urgency ?? "medium"] ?? urgencyConfig.medium;
  const riskInfo = riskConfig[ghostingRisk] ?? riskConfig.low;
  const SentimentIcon = sentimentInfo.icon;

  return (
    <div className="p-4 space-y-5">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Contact Intelligence
      </h3>

      {/* Summary */}
      {analysis?.summary_short && (
        <div>
          <p className="text-sm text-foreground leading-relaxed">{analysis.summary_short}</p>
        </div>
      )}

      <Separator />

      {/* Stage & Sentiment Row */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Stage</span>
          <Badge variant="outline" className="capitalize text-xs">
            <Target className="h-3 w-3 mr-1" />
            {dealStage.replace(/_/g, " ")}
          </Badge>
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Sentiment</span>
          <div className={cn("flex items-center gap-1 text-xs font-medium", sentimentInfo.color)}>
            <SentimentIcon className="h-3 w-3" />
            {sentimentInfo.label}
          </div>
        </div>
      </div>

      {/* Urgency & Ghosting Row */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Urgency</span>
          <Badge variant="outline" className={cn("text-xs", urgencyInfo.color)}>
            <Zap className="h-3 w-3 mr-1" />
            {urgencyInfo.label}
          </Badge>
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Ghost Risk</span>
          <span className={cn("text-xs font-medium", riskInfo.color)}>
            {riskInfo.label}
          </span>
        </div>
      </div>

      {/* Recommended Channel */}
      {analysis?.recommended_reply_channel && analysis.recommended_reply_channel !== "whatsapp" && (
        <>
          <Separator />
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">
              Recommended Channel
            </span>
            <Badge
              variant="secondary"
              className={cn(
                "text-xs capitalize",
                analysis.recommended_reply_channel === "whatsapp"
                  ? "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]"
                  : "bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))]"
              )}
            >
              {analysis.recommended_reply_channel === "whatsapp" ? (
                <MessageSquare className="h-3 w-3 mr-1" />
              ) : null}
              {analysis.recommended_reply_channel}
            </Badge>
          </div>
        </>
      )}

      {/* Objections */}
      {objections.length > 0 && (
        <>
          <Separator />
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-2">
              <Shield className="h-3 w-3 inline mr-1" />
              Objections ({objections.length})
            </span>
            <div className="space-y-1">
              {objections.map((obj, i) => (
                <p key={i} className="text-xs text-foreground bg-destructive/5 rounded px-2 py-1">
                  {obj}
                </p>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Buying Signals */}
      {buyingSignals.length > 0 && (
        <>
          <Separator />
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-2">
              <TrendingUp className="h-3 w-3 inline mr-1" />
              Buying Signals ({buyingSignals.length})
            </span>
            <div className="space-y-1">
              {buyingSignals.map((sig, i) => (
                <p key={i} className="text-xs text-foreground bg-[hsl(var(--success)/0.05)] rounded px-2 py-1">
                  {sig}
                </p>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Topics */}
      {allTopics.length > 0 && (
        <>
          <Separator />
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-2">Topics</span>
            <div className="flex flex-wrap gap-1">
              {allTopics.slice(0, 8).map((topic, i) => (
                <Badge key={i} variant="outline" className="text-[10px]">
                  {topic}
                </Badge>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
