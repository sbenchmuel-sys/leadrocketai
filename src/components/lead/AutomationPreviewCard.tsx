import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { RefreshCw, Pause, Play, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, addDays, addHours, parseISO } from "date-fns";
import type { LeadDetail } from "@/lib/supabaseQueries";
import type { Motion, DealStage } from "@/lib/dashboardUtils";
import { useAITask } from "@/hooks/useAITask";

interface AutomationPreviewCardProps {
  lead: LeadDetail;
  onUpdate: () => void;
}

// Cadence step labels
const STEP_LABELS: Record<string, string> = {
  send_pre_1: "Intro",
  send_pre_2: "Follow-up 1",
  send_pre_3: "Follow-up 2",
  send_pre_4: "Breakup",
  send_nurture_1: "Nurture 1",
  send_nurture_2: "Nurture 2",
  send_nurture_3: "Nurture 3",
};

// Default cadence intervals (days) per strategy
const CADENCE_DAYS: Record<string, number[]> = {
  fast: [2, 3, 3, 4],
  nurture: [5, 7, 7, 10],
};

type AutomationState = "active" | "paused" | "completed" | "hidden";

interface PauseReason {
  label: string;
}

interface ScheduledStep {
  label: string;
  stepKey: string;
  scheduledAt: Date;
}

function deriveAutomationState(lead: LeadDetail): {
  state: AutomationState;
  pauseReason?: PauseReason;
  steps: ScheduledStep[];
} {
  const motion = (lead.motion as Motion) || "outbound_prospecting";
  const stage = (lead.stage as DealStage) || "new";

  // Terminal
  if (stage === "closed_won" || stage === "closed_lost") {
    return { state: "completed", steps: [] };
  }

  // Not eligible for automation
  if (motion !== "outbound_prospecting" && motion !== "nurture") {
    return { state: "hidden", steps: [] };
  }

  // Paused: reply detected — any inbound means active conversation, automation should stop
  if (lead.last_inbound_at) {
    return { state: "paused", pauseReason: { label: "Reply received — active conversation" }, steps: [] };
  }

  // Paused: meeting scheduled
  if (lead.has_future_meeting) {
    return { state: "paused", pauseReason: { label: "Meeting scheduled" }, steps: [] };
  }

  // Derive current step and schedule
  const strategy = lead.strategy || "fast";
  const intervals = CADENCE_DAYS[strategy] || CADENCE_DAYS.fast;
  const actionKey = lead.next_action_key || "";

  // Determine current step index
  let currentStepIdx = 0;
  if (actionKey.startsWith("send_pre_")) {
    const num = parseInt(actionKey.replace("send_pre_", ""), 10);
    currentStepIdx = Math.max(0, num - 1);
  } else if (actionKey.startsWith("send_nurture_")) {
    const num = parseInt(actionKey.replace("send_nurture_", ""), 10);
    currentStepIdx = Math.max(0, num - 1);
  }

  // If we're past all steps, completed
  const isNurture = motion === "nurture";
  const maxSteps = isNurture ? 3 : 4;
  if (currentStepIdx >= maxSteps) {
    return { state: "completed", steps: [] };
  }

  // Calculate schedule based on last outbound or eligible_at
  const baseDate = lead.eligible_at
    ? parseISO(lead.eligible_at)
    : lead.last_outbound_at
    ? parseISO(lead.last_outbound_at)
    : new Date();

  const steps: ScheduledStep[] = [];
  const stepPrefix = isNurture ? "send_nurture_" : "send_pre_";

  // Next step
  const nextStepNum = currentStepIdx + 1;
  const nextInterval = intervals[currentStepIdx] || 3;
  const nextDate = lead.eligible_at
    ? parseISO(lead.eligible_at)
    : addDays(baseDate, nextInterval);
  // Set to 9:30 AM for display
  const nextScheduled = new Date(nextDate);
  nextScheduled.setHours(9, 30, 0, 0);

  steps.push({
    label: STEP_LABELS[`${stepPrefix}${nextStepNum}`] || `Step ${nextStepNum}`,
    stepKey: `${stepPrefix}${nextStepNum}`,
    scheduledAt: nextScheduled,
  });

  // Following step (if exists)
  if (currentStepIdx + 1 < maxSteps) {
    const followingStepNum = nextStepNum + 1;
    const followingInterval = intervals[currentStepIdx + 1] || 4;
    const followingDate = addDays(nextScheduled, followingInterval);
    followingDate.setHours(9, 0, 0, 0);

    steps.push({
      label: STEP_LABELS[`${stepPrefix}${followingStepNum}`] || `Step ${followingStepNum}`,
      stepKey: `${stepPrefix}${followingStepNum}`,
      scheduledAt: followingDate,
    });
  }

  return { state: "active", steps };
}

export default function AutomationPreviewCard({ lead, onUpdate }: AutomationPreviewCardProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [previewContent, setPreviewContent] = useState("");
  const [isPausing, setIsPausing] = useState(false);
  const { runTask, isLoading: isGenerating } = useAITask();

  const { state, pauseReason, steps } = useMemo(() => deriveAutomationState(lead), [lead]);

  // Don't render if automation not applicable
  if (state === "hidden") return null;

  const handlePreview = async () => {
    setShowPreview(true);
    if (!previewContent && steps.length > 0) {
      // Generate draft for next step
      const result = await runTask("pre_email_2_followup", {
        lead_context: [
          `Name: ${lead.name}`,
          `Company: ${lead.company}`,
          `Email: ${lead.email}`,
          lead.job_title && `Job Title: ${lead.job_title}`,
          `Strategy: ${lead.strategy}`,
          `Status: ${lead.status}`,
        ].filter(Boolean).join("\n"),
        previous_email_summary: "Previous outreach introducing our solution.",
        meeting_link: lead.meeting_link || "",
        lead_id: lead.id,
      });
      if (result.ok && result.content) {
        setPreviewContent(result.content);
      }
    }
  };

  const handlePause = async () => {
    setIsPausing(true);
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      await supabase
        .from("leads")
        .update({
          needs_action: false,
          next_action_key: null,
          next_action_label: "Automation paused",
          eligible_at: null,
        })
        .eq("id", lead.id);
      onUpdate();
    } finally {
      setIsPausing(false);
    }
  };

  const handleResume = async () => {
    setIsPausing(true);
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      await supabase
        .from("leads")
        .update({
          needs_action: true,
          next_action_label: "Automation resumed",
          eligible_at: new Date().toISOString(),
        })
        .eq("id", lead.id);
      onUpdate();
    } finally {
      setIsPausing(false);
    }
  };

  // ─── Completed ───
  if (state === "completed") {
    return (
      <Card className="bg-muted/30 border-border/50">
        <CardContent className="pt-4 pb-4 space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Automation Complete</span>
          </div>
          <p className="text-xs text-muted-foreground">No further emails scheduled.</p>
        </CardContent>
      </Card>
    );
  }

  // ─── Paused ───
  if (state === "paused") {
    return (
      <Card className="bg-muted/30 border-border/50">
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex items-center gap-2">
            <Pause className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-medium text-foreground">Automation Paused</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Reason: {pauseReason?.label || "Manually paused"}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleResume}
            disabled={isPausing}
            className="w-full text-xs h-7"
          >
            {isPausing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
            Resume
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ─── Active ───
  const nextStep = steps[0];
  const followingStep = steps[1];

  return (
    <>
      <Card className="bg-muted/30 border-border/50">
        <CardContent className="pt-4 pb-4 space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm font-medium text-foreground">Automation Active</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-medium">Active</span>
            </div>
          </div>

          <Separator className="bg-border/50" />

          {/* Next Email */}
          {nextStep && (
            <div className="space-y-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Next</span>
              <p className="text-sm font-semibold text-foreground">{nextStep.label}</p>
              <p className="text-xs text-muted-foreground">
                {format(nextStep.scheduledAt, "MMM d")} · {format(nextStep.scheduledAt, "h:mm a")}
              </p>
            </div>
          )}

          {/* Following Email */}
          {followingStep && (
            <div className="space-y-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Following</span>
              <p className="text-sm font-semibold text-foreground">{followingStep.label}</p>
              <p className="text-xs text-muted-foreground">
                {format(followingStep.scheduledAt, "MMM d")} · {format(followingStep.scheduledAt, "h:mm a")}
              </p>
            </div>
          )}

          <Separator className="bg-border/50" />

          {/* Footer Buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePreview}
              className="flex-1 text-xs h-7"
            >
              Preview
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePause}
              disabled={isPausing}
              className="flex-1 text-xs h-7 text-muted-foreground"
            >
              {isPausing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Pause className="h-3 w-3 mr-1" />}
              Pause
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Preview Modal */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">
              Preview: {nextStep?.label || "Next Email"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {nextStep && (
              <p className="text-xs text-muted-foreground">
                Scheduled: {format(nextStep.scheduledAt, "MMM d, yyyy")} · {format(nextStep.scheduledAt, "h:mm a")}
              </p>
            )}
            {isGenerating ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground ml-2">Generating preview…</span>
              </div>
            ) : (
              <Textarea
                value={previewContent}
                onChange={(e) => setPreviewContent(e.target.value)}
                rows={10}
                className="text-sm"
                placeholder="Draft will appear here..."
              />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowPreview(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
