// ============================================
// LAST-MILE REASONING PANEL — Internal Admin Only
// Shows orchestration context for generated replies
// Gated by VITE_ADMIN_TUNING=1
// ============================================

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, RefreshCw, Brain, Target, Shield, Layers, Clock } from "lucide-react";

// ── Types matching API response shape ──

export interface OrchestrationContext {
  decision?: {
    detected_objection_classes: string[];
    detected_commercial_intent: string;
    response_strategy: string;
    proof_strategy: string;
    cta_strategy: string;
    confidence: string;
  };
  stage_policy?: {
    effective_stage: string;
    final_cta_strategy: string;
    final_preferred_offer_categories: string[];
    final_suppressed_offer_categories: string[];
    stage_reasoning: string;
    is_urgent: boolean;
  };
  reply_objective?: {
    primary: string;
    secondary: string | null;
    reasoning: string;
    confidence: string;
    override_source: string | null;
  };
  reply_evaluation?: {
    objective_alignment_score: number;
    cta_alignment_score: number;
    focus_score: number;
    commercial_relevance_score: number;
    policy_violations: Array<{ rule: string; severity: string }>;
    regeneration_recommended: boolean;
    evaluation_summary: string;
    dominant_layer: string;
  };
  offer?: {
    offer_key: string;
    offer_name: string;
    link_url?: string;
    cta_type: string;
    match_reason: string;
    score: number;
  };
  deal_memory?: {
    momentum_state: string;
    handled_objections: string[];
    unresolved_objections: string[];
    shared_assets: string[];
    sent_offers: string[];
    recent_cta_patterns: string[];
    unanswered_questions: string[];
    pending_buyin_needs: string[];
    pricing_status: string;
    continuity_risks: string[];
    ignored_cta_count: number;
  };
  regenerated?: boolean;
  framework_used?: string;
}

// ── Score bar component ──

function ScoreBar({ label, score, max = 10 }: { label: string; score: number; max?: number }) {
  const pct = Math.round((score / max) * 100);
  const color = pct >= 70 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 text-muted-foreground truncate">{label}</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-mono">{score}/{max}</span>
    </div>
  );
}

// ── Section component ──

function Section({ title, icon, children, defaultOpen = false }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full py-1 px-2 rounded hover:bg-muted/50 text-xs font-medium">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {icon}
        <span>{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-7 pr-2 pb-2 space-y-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TagList({ items, variant = "outline" }: { items: string[]; variant?: "outline" | "destructive" | "secondary" }) {
  if (!items.length) return <span className="text-xs text-muted-foreground italic">none</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(item => (
        <Badge key={item} variant={variant} className="text-[10px] px-1.5 py-0">
          {item.replace(/_/g, " ")}
        </Badge>
      ))}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string | number | boolean | null | undefined }) {
  if (value === undefined || value === null) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted-foreground w-32 shrink-0">{label}</span>
      <span className="font-medium">{typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}</span>
    </div>
  );
}

// ── Main panel ──

export function LastMileReasoningPanel({ context }: { context: OrchestrationContext | null }) {
  if (!context) return null;

  const { decision, stage_policy, reply_objective, reply_evaluation, offer, deal_memory, regenerated } = context;
  const hasOrchestration = decision || stage_policy || reply_objective || reply_evaluation || deal_memory;
  if (!hasOrchestration) return null;

  const totalScore = reply_evaluation
    ? reply_evaluation.objective_alignment_score + reply_evaluation.cta_alignment_score +
      reply_evaluation.focus_score + reply_evaluation.commercial_relevance_score
    : null;

  return (
    <Card className="border-dashed border-amber-500/50 bg-amber-500/5">
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-xs flex items-center gap-2 text-amber-700 dark:text-amber-400">
          <Brain className="h-3.5 w-3.5" />
          Last-Mile Orchestration
          {regenerated && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-auto">
              <RefreshCw className="h-2.5 w-2.5 mr-1" />
              Regenerated
            </Badge>
          )}
          {totalScore !== null && (
            <Badge variant={totalScore >= 30 ? "secondary" : "destructive"} className="text-[10px] px-1.5 py-0 ml-auto">
              {totalScore}/40
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 space-y-1">

        {/* Objection + Intent Classification */}
        {decision && (
          <Section title="Intent Classification" icon={<Target className="h-3 w-3 text-blue-500" />}>
            <div className="space-y-1.5">
              <div>
                <span className="text-[10px] text-muted-foreground">Objection classes</span>
                <TagList items={decision.detected_objection_classes} />
              </div>
              <KV label="Commercial intent" value={decision.detected_commercial_intent} />
              <KV label="CTA strategy" value={decision.cta_strategy} />
              <KV label="Confidence" value={decision.confidence} />
            </div>
          </Section>
        )}

        {/* Stage Policy */}
        {stage_policy && (
          <Section title="Stage Policy" icon={<Layers className="h-3 w-3 text-purple-500" />}>
            <div className="space-y-1.5">
              <KV label="Effective stage" value={stage_policy.effective_stage} />
              <KV label="CTA strategy" value={stage_policy.final_cta_strategy} />
              <KV label="Urgent" value={stage_policy.is_urgent} />
              <div>
                <span className="text-[10px] text-muted-foreground">Preferred offers</span>
                <TagList items={stage_policy.final_preferred_offer_categories} variant="secondary" />
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground">Suppressed offers</span>
                <TagList items={stage_policy.final_suppressed_offer_categories} variant="destructive" />
              </div>
              <KV label="Reasoning" value={stage_policy.stage_reasoning} />
            </div>
          </Section>
        )}

        {/* Reply Objective */}
        {reply_objective && (
          <Section title="Reply Objective" icon={<Target className="h-3 w-3 text-green-500" />} defaultOpen>
            <div className="space-y-1.5">
              <KV label="Primary" value={reply_objective.primary?.replace(/_/g, " ")} />
              {reply_objective.secondary && (
                <KV label="Secondary" value={reply_objective.secondary.replace(/_/g, " ")} />
              )}
              <KV label="Confidence" value={reply_objective.confidence} />
              {reply_objective.override_source && (
                <KV label="Override source" value={reply_objective.override_source} />
              )}
              <KV label="Reasoning" value={reply_objective.reasoning} />
            </div>
          </Section>
        )}

        {/* Selected Offer */}
        {offer && (
          <Section title="Recommended Offer" icon={<Shield className="h-3 w-3 text-cyan-500" />}>
            <div className="space-y-1.5">
              <KV label="Offer" value={offer.offer_name} />
              <KV label="CTA type" value={offer.cta_type} />
              <KV label="Match reason" value={offer.match_reason} />
              <KV label="Score" value={offer.score} />
              {offer.link_url && <KV label="Link" value={offer.link_url} />}
            </div>
          </Section>
        )}

        {/* Evaluation */}
        {reply_evaluation && (
          <Section title="Evaluation" icon={
            reply_evaluation.policy_violations.length === 0
              ? <CheckCircle2 className="h-3 w-3 text-green-500" />
              : <AlertTriangle className="h-3 w-3 text-amber-500" />
          } defaultOpen={reply_evaluation.policy_violations.length > 0}>
            <div className="space-y-2">
              <div className="space-y-1">
                <ScoreBar label="Objective align" score={reply_evaluation.objective_alignment_score} />
                <ScoreBar label="CTA align" score={reply_evaluation.cta_alignment_score} />
                <ScoreBar label="Focus" score={reply_evaluation.focus_score} />
                <ScoreBar label="Commercial rel." score={reply_evaluation.commercial_relevance_score} />
              </div>
              {reply_evaluation.policy_violations.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Violations</span>
                  <div className="space-y-0.5 mt-0.5">
                    {reply_evaluation.policy_violations.map((v, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-[10px]">
                        <Badge
                          variant={v.severity === "high" ? "destructive" : "outline"}
                          className="text-[9px] px-1 py-0"
                        >
                          {v.severity}
                        </Badge>
                        <span className="font-mono">{v.rule}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <KV label="Dominant layer" value={reply_evaluation.dominant_layer} />
              <KV label="Summary" value={reply_evaluation.evaluation_summary} />
            </div>
          </Section>
        )}

        {/* Deal Memory / Continuity */}
        {deal_memory && (
          <Section title={`Deal Memory — ${deal_memory.momentum_state}`} icon={<Clock className="h-3 w-3 text-orange-500" />}>
            <div className="space-y-1.5">
              <KV label="Momentum" value={deal_memory.momentum_state} />
              <KV label="Pricing status" value={deal_memory.pricing_status} />
              <KV label="Ignored CTAs" value={deal_memory.ignored_cta_count} />
              {deal_memory.unresolved_objections.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Unresolved objections</span>
                  <TagList items={deal_memory.unresolved_objections} variant="destructive" />
                </div>
              )}
              {deal_memory.handled_objections.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Handled objections</span>
                  <TagList items={deal_memory.handled_objections} variant="secondary" />
                </div>
              )}
              {deal_memory.unanswered_questions.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Unanswered questions</span>
                  <div className="space-y-0.5 mt-0.5">
                    {deal_memory.unanswered_questions.map((q, i) => (
                      <div key={i} className="text-[10px] text-muted-foreground">• {q}</div>
                    ))}
                  </div>
                </div>
              )}
              {deal_memory.shared_assets.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Shared assets</span>
                  <TagList items={deal_memory.shared_assets} />
                </div>
              )}
              {deal_memory.sent_offers.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Sent offers</span>
                  <TagList items={deal_memory.sent_offers} />
                </div>
              )}
              {deal_memory.recent_cta_patterns.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Recent CTAs</span>
                  <TagList items={deal_memory.recent_cta_patterns} />
                </div>
              )}
              {deal_memory.continuity_risks.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Continuity risks</span>
                  <TagList items={deal_memory.continuity_risks} variant="destructive" />
                </div>
              )}
              {deal_memory.pending_buyin_needs.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Pending buy-in</span>
                  <TagList items={deal_memory.pending_buyin_needs} />
                </div>
              )}
            </div>
          </Section>
        )}
      </CardContent>
    </Card>
  );
}
