// AutomationPreviewCard — optional automation with pre-send safety checks
import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Zap, Pause, Play, Loader2, ShieldCheck, Clock, Square, Ban, Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, addDays } from "date-fns";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { getMotionIntervals, getNurtureCadenceDays } from "@/lib/cadenceSettingsTypes";
import AutomationDraftPreviewDialog from "./AutomationDraftPreviewDialog";
import CampaignStepPreview from "./CampaignStepPreview";

interface AutomationPreviewCardProps {
  lead: LeadDetail;
  onUpdate: () => void;
}

// Step labels for outbound prospecting sequence
const OUTBOUND_STEP_LABELS: Record<string, string> = {
  send_pre_1: "Intro Email",
  send_pre_2: "Follow-up 1",
  send_pre_3: "Follow-up 2",
  send_pre_4: "Breakup Email",
};

const INBOUND_STEP_LABELS: Record<string, string> = {
  send_pre_1: "Intro Reply",
  send_pre_2: "Follow-up 1",
  send_pre_3: "Follow-up 2",
};

const NURTURE_STEP_LABELS: Record<string, string> = {
  nurture_1: "Nurture Email 1",
  nurture_2: "Nurture Email 2",
  nurture_3: "Nurture Email 3",
  nurture_4: "Nurture Email 4",
};

function getStepLabels(motion: string): Record<string, string> {
  if (motion === "inbound_response") return INBOUND_STEP_LABELS;
  if (motion === "nurture") return NURTURE_STEP_LABELS;
  return OUTBOUND_STEP_LABELS;
}

function getMaxSteps(motion: string): number {
  const intervals = getMotionIntervals(motion);
  return intervals.length;
}

function getNextTwoSteps(lead: LeadDetail) {
  const motion = lead.motion || "outbound_prospecting";
  const stepLabels = getStepLabels(motion);
  const eligibleAt = (lead as any).eligible_at ? new Date((lead as any).eligible_at) : null;

  // Nurture uses cadence-based scheduling
  if (motion === "nurture") {
    const cadence = (lead as any).nurture_cadence || "biweekly";
    const gapDays = getNurtureCadenceDays(cadence);
    const actionKey = lead.next_action_key || "nurture_1";
    const stepMatch = actionKey.match(/nurture_(\d+)/);
    const stepNum = stepMatch ? parseInt(stepMatch[1], 10) : 1;

    const steps: { key: string; label: string; date: Date }[] = [];
    for (let i = 0; i < 2; i++) {
      const num = stepNum + i;
      const key = `nurture_${num}`;
      const label = stepLabels[key] || `Nurture Email ${num}`;
      let date: Date;
      if (i === 0 && eligibleAt) {
        date = eligibleAt;
      } else {
        const prevDate = i === 0 ? new Date() : steps[i - 1]?.date || new Date();
        date = addDays(prevDate, gapDays);
        date.setHours(9, 30, 0, 0);
      }
      if (date.getTime() <= Date.now()) {
        date = new Date();
        date.setMinutes(date.getMinutes() + 5);
      }
      steps.push({ key, label, date });
    }
    return steps;
  }

  // Outbound / Inbound uses interval-based scheduling
  const intervals = getMotionIntervals(motion);
  const maxSteps = intervals.length;

  const actionKey = lead.next_action_key || "send_pre_1";
  const stepMatch = actionKey.match(/send_pre_(\d)/);
  const stepNum = stepMatch ? parseInt(stepMatch[1], 10) : 1;

  const steps: { key: string; label: string; date: Date }[] = [];
  const baseDate = lead.last_outbound_at ? new Date(lead.last_outbound_at) : new Date();

  for (let i = 0; i < 2; i++) {
    const idx = stepNum - 1 + i;
    if (idx >= maxSteps) break;
    const key = `send_pre_${idx + 1}`;
    const label = stepLabels[key] || `Step ${idx + 1}`;
    
    let date: Date;
    if (i === 0 && eligibleAt) {
      date = eligibleAt;
    } else {
      const gapDays = idx > 0 ? intervals[idx] - intervals[idx - 1] : 0;
      const prevDate = i === 0 ? baseDate : steps[i - 1]?.date || baseDate;
      date = addDays(prevDate, i === 0 ? 0 : gapDays);
      date.setHours(9, 30, 0, 0);
    }
    
    if (date.getTime() <= Date.now()) {
      date = new Date();
      date.setMinutes(date.getMinutes() + 5);
    }
    
    steps.push({ key, label, date });
  }

  return steps;
}

function getAutomationBlockers(lead: LeadDetail): string[] {
  const blockers: string[] = [];
  if (lead.last_inbound_at) blockers.push("Lead has replied");
  if (lead.has_future_meeting) blockers.push("Meeting scheduled");
  if (lead.motion !== "outbound_prospecting" && lead.motion !== "inbound_response" && lead.motion !== "nurture") blockers.push("Motion changed");
  const stage = lead.stage;
  if (stage === "closed_won" || stage === "closed_lost") blockers.push("Deal closed");
  return blockers;
}

export default function AutomationPreviewCard({ lead, onUpdate }: AutomationPreviewCardProps) {
  const [isEnabling, setIsEnabling] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [previewStep, setPreviewStep] = useState<{ key: string; label: string } | null>(null);

  const motion = lead.motion;
  const stage = lead.stage;
  const isUnsubscribed = (lead as any).unsubscribed === true;

  const hasAutomationEnabled = !!(lead as any).eligible_at && lead.needs_action;
  const blockers = useMemo(() => getAutomationBlockers(lead), [lead]);
  const safetyPaused = blockers.length > 0;
  const userPaused = !hasAutomationEnabled && !!lead.next_action_key;
  const isPaused = safetyPaused || userPaused;
  const steps = useMemo(() => getNextTwoSteps(lead), [lead]);

  const intervals = getMotionIntervals(motion || "outbound_prospecting");
  const stepLabels = getStepLabels(motion || "outbound_prospecting");

  const isEligible = (motion === "outbound_prospecting" || motion === "inbound_response" || motion === "nurture") &&
    stage !== "closed_won" && stage !== "closed_lost";

  if (!isEligible) return null;

  // Unsubscribed state
  if (isUnsubscribed) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Ban className="h-3.5 w-3.5 text-destructive" />
          <span className="text-sm font-medium text-foreground">Automation</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium">
            Unsubscribed
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          This lead requested to unsubscribe. Automation is permanently disabled.
        </p>
        <Separator className="bg-border/40" />
      </div>
    );
  }

  // Stop sequence handler — permanently clears all automation
  const handleStopSequence = async () => {
    setIsStopping(true);
    try {
      await supabase
        .from("leads")
        .update({
          needs_action: false,
          next_action_key: null,
          next_action_label: null,
          eligible_at: null,
          action_reason_code: null,
        })
        .eq("id", lead.id);
      toast.success("Sequence stopped permanently");
      onUpdate();
    } catch (err) {
      console.error("Failed to stop sequence:", err);
      toast.error("Failed to stop sequence");
    } finally {
      setIsStopping(false);
    }
  };

  // Not enabled — show enable button
  if (!hasAutomationEnabled && !lead.next_action_key) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Automation</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
            Off
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Enable to auto-schedule follow-ups. System pauses on reply or meeting.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            setIsEnabling(true);
            try {
              let updateFields: Record<string, any>;

              if (motion === "nurture") {
                const cadence = (lead as any).nurture_cadence || "biweekly";
                const gapDays = getNurtureCadenceDays(cadence);
                const stepNum = ((lead as any).nurture_outbound_count || 0) + 1;
                let eligibleAt = addDays(new Date(), gapDays);
                eligibleAt.setHours(9, 30, 0, 0);
                if (eligibleAt.getTime() <= Date.now()) eligibleAt = addDays(eligibleAt, 1);

                updateFields = {
                  needs_action: true,
                  next_action_key: `nurture_${stepNum}`,
                  next_action_label: `Nurture Email ${stepNum}`,
                  eligible_at: eligibleAt.toISOString(),
                  action_reason_code: "NURTURE_DUE",
                  nurture_status: "active",
                  nurture_mode: (lead as any).nurture_mode || "review",
                };
              } else {
                const hasOutbound = !!(lead as any).last_outbound_at;
                const nextKey = hasOutbound ? (lead.next_action_key || "send_pre_2") : "send_pre_1";
                const nextLabel = stepLabels[nextKey] || "Intro Email";
                const stepIdx = parseInt(nextKey.replace("send_pre_", ""), 10) - 1;
                const gapDays = stepIdx > 0 && stepIdx < intervals.length
                  ? intervals[stepIdx] - intervals[stepIdx - 1]
                  : (hasOutbound ? intervals[1] - intervals[0] : 0);
                
                let eligibleAt: Date;
                if (gapDays === 0) {
                  eligibleAt = new Date();
                  eligibleAt.setMinutes(eligibleAt.getMinutes() + 5);
                } else {
                  eligibleAt = addDays(new Date(), gapDays);
                  eligibleAt.setHours(9, 30, 0, 0);
                  if (eligibleAt.getTime() <= Date.now()) eligibleAt = addDays(eligibleAt, 1);
                }

                updateFields = {
                  needs_action: true,
                  next_action_key: nextKey,
                  next_action_label: nextLabel,
                  eligible_at: eligibleAt.toISOString(),
                  action_reason_code: "FOLLOWUP_DUE",
                };
              }

              await supabase
                .from("leads")
                .update(updateFields)
                .eq("id", lead.id);

              toast.success("Automation enabled. Next step scheduled.");
              onUpdate();
            } catch (err) {
              console.error("Failed to enable automation:", err);
              toast.error("Failed to enable automation");
            } finally {
              setIsEnabling(false);
            }
          }}
          disabled={isEnabling}
          className="w-full text-xs h-7"
        >
          {isEnabling ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Zap className="h-3 w-3 mr-1" />
          )}
          Enable Automation
        </Button>
        <Separator className="bg-border/40" />
      </div>
    );
  }

  // Automation enabled — show status
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-primary" />
          <span className="text-sm font-medium text-foreground">
            Automation
            <span className={cn(
              "ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium",
              isPaused
                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
            )}>
              {isPaused ? "Paused" : "Active"}
            </span>
          </span>
        </div>
      </div>

      {/* Safety blockers */}
      {safetyPaused && blockers.length > 0 && (
        <div className="space-y-1">
          {blockers.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <ShieldCheck className="h-3 w-3" />
              <span>{b} — automation paused</span>
            </div>
          ))}
        </div>
      )}

      {/* User-paused message */}
      {userPaused && !safetyPaused && (
        <p className="text-xs text-muted-foreground">Automation paused manually. Click Resume to continue the sequence.</p>
      )}

      {/* Scheduled steps */}
      {!isPaused && steps.length > 0 && (
        <div className="space-y-2">
          {steps.map((step, i) => (
            <div key={step.key} className="space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                  {i === 0 ? "Next" : "Following"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPreviewStep({ key: step.key, label: step.label })}
                  className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <Eye className="h-3 w-3 mr-0.5" />
                  Preview
                </Button>
              </div>
              <p className="text-sm font-semibold text-foreground">{step.label}</p>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {format(step.date, "MMM d")} · {format(step.date, "h:mm a")}
              </p>
            </div>
          ))}
        </div>
      )}

      <Separator className="bg-border/40" />

      {/* Safety paused: show Stop Sequence (red) + Resume (amber) */}
      {safetyPaused ? (
        <div className="space-y-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleStopSequence}
            disabled={isStopping}
            className="w-full text-xs h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            {isStopping ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Square className="h-3 w-3 mr-1" />
            )}
            Stop Sequence
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              setIsPausing(true);
              try {
                const freshBlockers = getAutomationBlockers(lead);
                if (freshBlockers.length > 0) {
                  toast.error(`Cannot resume: ${freshBlockers[0]}`);
                  return;
                }
                let updateFields: Record<string, any>;
                if (motion === "nurture") {
                  const cadence = (lead as any).nurture_cadence || "biweekly";
                  const gapDays = getNurtureCadenceDays(cadence);
                  const stepNum = ((lead as any).nurture_outbound_count || 0) + 1;
                  let eligibleAt = addDays(new Date(), gapDays);
                  eligibleAt.setHours(9, 30, 0, 0);
                  if (eligibleAt.getTime() <= Date.now()) eligibleAt = addDays(eligibleAt, 1);
                  updateFields = {
                    needs_action: true,
                    next_action_key: `nurture_${stepNum}`,
                    next_action_label: `Nurture Email ${stepNum}`,
                    eligible_at: eligibleAt.toISOString(),
                  };
                } else {
                  const hasOutbound = !!(lead as any).last_outbound_at;
                  const nextKey = hasOutbound ? (lead.next_action_key || "send_pre_2") : "send_pre_1";
                  const nextLabel = stepLabels[nextKey] || "Follow-up";
                  const stepIdx = parseInt(nextKey.replace("send_pre_", ""), 10) - 1;
                  const gapDays = stepIdx > 0 && stepIdx < intervals.length
                    ? intervals[stepIdx] - intervals[stepIdx - 1]
                    : (hasOutbound ? 2 : 0);
                  let eligibleAt: Date;
                  if (gapDays === 0) {
                    eligibleAt = new Date();
                    eligibleAt.setMinutes(eligibleAt.getMinutes() + 5);
                  } else {
                    eligibleAt = addDays(new Date(), gapDays);
                    eligibleAt.setHours(9, 30, 0, 0);
                    if (eligibleAt.getTime() <= Date.now()) eligibleAt = addDays(eligibleAt, 1);
                  }
                  updateFields = {
                    needs_action: true,
                    next_action_key: nextKey,
                    next_action_label: nextLabel,
                    eligible_at: eligibleAt.toISOString(),
                  };
                }
                await supabase
                  .from("leads")
                  .update(updateFields)
                  .eq("id", lead.id);
                toast.success("Automation resumed");
                onUpdate();
              } catch (err) {
                console.error("Failed to resume automation:", err);
              } finally {
                setIsPausing(false);
              }
            }}
            disabled={isPausing}
            className="w-full text-xs h-7 text-muted-foreground"
          >
            {isPausing ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Play className="h-3 w-3 mr-1" />
            )}
            Resume Anyway
          </Button>
        </div>
      ) : userPaused ? (
        /* User-paused: show Resume */
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            setIsPausing(true);
            try {
              const freshBlockers = getAutomationBlockers(lead);
              if (freshBlockers.length > 0) {
                toast.error(`Cannot resume: ${freshBlockers[0]}`);
                return;
              }
              let updateFields: Record<string, any>;
              if (motion === "nurture") {
                const cadence = (lead as any).nurture_cadence || "biweekly";
                const gapDays = getNurtureCadenceDays(cadence);
                const stepNum = ((lead as any).nurture_outbound_count || 0) + 1;
                let eligibleAt = addDays(new Date(), gapDays);
                eligibleAt.setHours(9, 30, 0, 0);
                if (eligibleAt.getTime() <= Date.now()) eligibleAt = addDays(eligibleAt, 1);
                updateFields = {
                  needs_action: true,
                  next_action_key: `nurture_${stepNum}`,
                  next_action_label: `Nurture Email ${stepNum}`,
                  eligible_at: eligibleAt.toISOString(),
                };
              } else {
                const hasOutbound = !!(lead as any).last_outbound_at;
                const nextKey = hasOutbound ? (lead.next_action_key || "send_pre_2") : "send_pre_1";
                const nextLabel = stepLabels[nextKey] || "Follow-up";
                const stepIdx = parseInt(nextKey.replace("send_pre_", ""), 10) - 1;
                const gapDays = stepIdx > 0 && stepIdx < intervals.length
                  ? intervals[stepIdx] - intervals[stepIdx - 1]
                  : (hasOutbound ? 2 : 0);
                let eligibleAt: Date;
                if (gapDays === 0) {
                  eligibleAt = new Date();
                  eligibleAt.setMinutes(eligibleAt.getMinutes() + 5);
                } else {
                  eligibleAt = addDays(new Date(), gapDays);
                  eligibleAt.setHours(9, 30, 0, 0);
                  if (eligibleAt.getTime() <= Date.now()) eligibleAt = addDays(eligibleAt, 1);
                }
                updateFields = {
                  needs_action: true,
                  next_action_key: nextKey,
                  next_action_label: nextLabel,
                  eligible_at: eligibleAt.toISOString(),
                };
              }
              await supabase
                .from("leads")
                .update(updateFields)
                .eq("id", lead.id);
              toast.success("Automation resumed");
              onUpdate();
            } catch (err) {
              console.error("Failed to resume automation:", err);
            } finally {
              setIsPausing(false);
            }
          }}
          disabled={isPausing}
          className="w-full text-xs h-7 text-muted-foreground"
        >
          {isPausing ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Play className="h-3 w-3 mr-1" />
          )}
          Resume
        </Button>
      ) : (
        /* Active: show Pause + Disable */
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              setIsPausing(true);
              try {
                await supabase
                  .from("leads")
                  .update({
                    needs_action: false,
                    eligible_at: null,
                  })
                  .eq("id", lead.id);
                toast.success("Automation paused");
                onUpdate();
              } catch (err) {
                console.error("Failed to pause automation:", err);
              } finally {
                setIsPausing(false);
              }
            }}
            disabled={isPausing}
            className="w-full text-xs h-7 text-muted-foreground"
          >
            {isPausing ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Pause className="h-3 w-3 mr-1" />
            )}
            Pause
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await supabase
                .from("leads")
                .update({
                  needs_action: false,
                  next_action_key: null,
                  next_action_label: null,
                  eligible_at: null,
                  action_reason_code: null,
                })
                .eq("id", lead.id);
              toast.success("Automation disabled");
              onUpdate();
            }}
            className="w-full text-xs h-7 text-destructive/70 hover:text-destructive"
          >
            Disable Automation
          </Button>
        </>
      )}
      {/* Sequence Step Preview (resolved from campaign model) */}
      <CampaignStepPreview
        motion={lead.motion}
        channel="email"
        actionInstructions={(lead as any).action_instructions}
        outboundTone={(lead as any).outbound_tone}
      />
      {/* Draft Preview Dialog */}
      {previewStep && (
        <AutomationDraftPreviewDialog
          open={!!previewStep}
          onOpenChange={(open) => { if (!open) setPreviewStep(null); }}
          lead={lead}
          stepKey={previewStep.key}
          stepLabel={previewStep.label}
          onSaved={onUpdate}
        />
      )}
    </div>
  );
}
