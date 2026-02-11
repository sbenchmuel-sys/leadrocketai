// AutomationPreviewCard — optional automation with pre-send safety checks
import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Zap, Pause, Play, Loader2, ShieldCheck, Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, addDays } from "date-fns";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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

// Intervals in days for fast strategy
const FAST_INTERVALS = [2, 3, 3, 4];

function getNextTwoSteps(lead: LeadDetail) {
  // Determine current step from next_action_key or infer from outbound count
  const actionKey = lead.next_action_key || "send_pre_1";
  const stepMatch = actionKey.match(/send_pre_(\d)/);
  const stepNum = stepMatch ? parseInt(stepMatch[1], 10) : 1;

  const steps: { key: string; label: string; date: Date }[] = [];
  const baseDate = lead.last_outbound_at ? new Date(lead.last_outbound_at) : new Date();

  for (let i = 0; i < 2; i++) {
    const idx = stepNum - 1 + i;
    if (idx >= 4) break;
    const key = `send_pre_${idx + 1}`;
    const label = OUTBOUND_STEP_LABELS[key] || `Step ${idx + 1}`;
    const daysOffset = FAST_INTERVALS.slice(0, idx + 1).reduce((a, b) => a + b, 0);
    const date = addDays(baseDate, i === 0 ? 0 : daysOffset);
    date.setHours(9, 30, 0, 0);
    steps.push({ key, label, date });
  }

  return steps;
}

// Safety checks before automation can proceed
function getAutomationBlockers(lead: LeadDetail): string[] {
  const blockers: string[] = [];
  if (lead.last_inbound_at) blockers.push("Lead has replied");
  if (lead.has_future_meeting) blockers.push("Meeting scheduled");
  if (lead.motion !== "outbound_prospecting") blockers.push("Motion changed");
  const stage = lead.stage;
  if (stage === "closed_won" || stage === "closed_lost") blockers.push("Deal closed");
  return blockers;
}

export default function AutomationPreviewCard({ lead, onUpdate }: AutomationPreviewCardProps) {
  const [isEnabling, setIsEnabling] = useState(false);
  const [isPausing, setIsPausing] = useState(false);

  const motion = lead.motion;
  const stage = lead.stage;

  const hasAutomationEnabled = !!(lead as any).eligible_at && lead.needs_action;
  const blockers = useMemo(() => getAutomationBlockers(lead), [lead]);
  const isPaused = blockers.length > 0;
  const steps = useMemo(() => getNextTwoSteps(lead), [lead]);

  // Only show for outbound_prospecting motion, non-closed stages
  const isEligible = motion === "outbound_prospecting" &&
    stage !== "closed_won" && stage !== "closed_lost";

  if (!isEligible) return null;

  // If automation is not enabled and there's no next action queued, show enable button
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
              // Determine next step
              const nextKey = lead.next_action_key || "send_pre_2";
              const nextLabel = OUTBOUND_STEP_LABELS[nextKey] || "Follow-up";
              const eligibleAt = addDays(new Date(), FAST_INTERVALS[0]);
              eligibleAt.setHours(9, 30, 0, 0);

              await supabase
                .from("leads")
                .update({
                  needs_action: true,
                  next_action_key: nextKey,
                  next_action_label: nextLabel,
                  eligible_at: eligibleAt.toISOString(),
                  action_reason_code: "FOLLOWUP_DUE",
                })
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

  // Automation is enabled — show status
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
      {isPaused && blockers.length > 0 && (
        <div className="space-y-1">
          {blockers.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <ShieldCheck className="h-3 w-3" />
              <span>{b} — automation paused</span>
            </div>
          ))}
        </div>
      )}

      {/* Scheduled steps */}
      {!isPaused && steps.length > 0 && (
        <div className="space-y-2">
          {steps.map((step, i) => (
            <div key={step.key} className="space-y-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                {i === 0 ? "Next" : "Following"}
              </span>
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

      {/* Pause / Resume */}
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          setIsPausing(true);
          try {
            if (isPaused) {
              // Resume — re-check safety first
              const freshBlockers = getAutomationBlockers(lead);
              if (freshBlockers.length > 0) {
                toast.error(`Cannot resume: ${freshBlockers[0]}`);
                return;
              }
              const nextKey = lead.next_action_key || "send_pre_2";
              const nextLabel = OUTBOUND_STEP_LABELS[nextKey] || "Follow-up";
              const eligibleAt = addDays(new Date(), FAST_INTERVALS[0]);
              eligibleAt.setHours(9, 30, 0, 0);

              await supabase
                .from("leads")
                .update({
                  needs_action: true,
                  next_action_key: nextKey,
                  next_action_label: nextLabel,
                  eligible_at: eligibleAt.toISOString(),
                })
                .eq("id", lead.id);
              toast.success("Automation resumed");
            } else {
              // Pause
              await supabase
                .from("leads")
                .update({
                  needs_action: false,
                  eligible_at: null,
                })
                .eq("id", lead.id);
              toast.success("Automation paused");
            }
            onUpdate();
          } catch (err) {
            console.error("Failed to toggle automation:", err);
          } finally {
            setIsPausing(false);
          }
        }}
        disabled={isPausing}
        className="w-full text-xs h-7 text-muted-foreground"
      >
        {isPausing ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : isPaused ? (
          <Play className="h-3 w-3 mr-1" />
        ) : (
          <Pause className="h-3 w-3 mr-1" />
        )}
        {isPaused ? "Resume" : "Pause"}
      </Button>

      {/* Disable completely */}
      {!isPaused && (
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
      )}
    </div>
  );
}
