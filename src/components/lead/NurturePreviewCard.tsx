import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Sprout, Pause, Play, Loader2, Eye, Wand2, Zap, CheckCircle2, Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, addDays, isPast } from "date-fns";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { saveDraft } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { generateDraft as generateDraftPipeline } from "@/lib/generateDraft";
import { toast } from "sonner";

interface NurturePreviewCardProps {
  lead: LeadDetail;
  onUpdate: () => void;
}

type NurtureMode = "review" | "automatic";
type NurtureStatus = "active" | "paused" | "inactive";

const CADENCE_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

const THEME_LABELS: Record<string, string> = {
  balanced: "Balanced",
  educational: "Educational",
  case_study: "Case Study",
};

const NURTURE_STEP_LABELS = ["Industry Insight", "Case Study", "Value-Add Resource"];

function getScheduledDates(lead: LeadDetail) {
  const cadence = lead.nurture_cadence || "biweekly";
  const days = CADENCE_DAYS[cadence] || 14;
  const base = lead.mode_changed_at ? new Date(lead.mode_changed_at) : new Date();
  const nurtureSent = (lead as any).nurture_outbound_count || 0;

  const nextDate = addDays(base, days * (nurtureSent + 1));
  nextDate.setHours(9, 30, 0, 0);
  const followingDate = addDays(base, days * (nurtureSent + 2));
  followingDate.setHours(9, 0, 0, 0);

  const nextLabel = NURTURE_STEP_LABELS[nurtureSent % NURTURE_STEP_LABELS.length];
  const followingLabel = NURTURE_STEP_LABELS[(nurtureSent + 1) % NURTURE_STEP_LABELS.length];

  return { nextDate, followingDate, nextLabel, followingLabel };
}

export default function NurturePreviewCard({ lead, onUpdate }: NurturePreviewCardProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [previewContent, setPreviewContent] = useState("");
  const [previewSubject, setPreviewSubject] = useState("");
  const [previewTarget, setPreviewTarget] = useState<"next" | "following">("next");
  const [isApproving, setIsApproving] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const mode = ((lead as any).nurture_mode as NurtureMode) || "review";
  const status = ((lead as any).nurture_status as NurtureStatus) || "inactive";
  const theme = ((lead as any).nurture_theme as string) || "balanced";
  const nurtureSent = (lead as any).nurture_outbound_count || 0;

  // Don't render if not in nurture
  if (lead.motion !== "nurture" || status === "inactive") return null;

  const { nextDate, followingDate, nextLabel, followingLabel } = useMemo(
    () => getScheduledDates(lead),
    [lead]
  );

  // Re-engagement safety
  const isReEngaged = !!lead.last_inbound_at || lead.has_future_meeting;

  const handleGenerateDraft = async (target: "next" | "following") => {
    setPreviewTarget(target);
    setShowPreview(true);
    setPreviewContent("");
    setPreviewSubject("");
    setIsGenerating(true);

    try {
      const pipelineResult = await generateDraftPipeline({
        lead_id: lead.id,
        channel: "email",
        override_intent: "nurture_email_single",
        motion_override: "nurture",
      });

      if (pipelineResult.draft_text) {
        const lines = pipelineResult.draft_text.split("\n");
        const subjectLine = lines.find(l => l.toLowerCase().startsWith("subject:"));
        if (subjectLine) {
          setPreviewSubject(subjectLine.replace(/^subject:\s*/i, "").trim());
          setPreviewContent(lines.filter(l => !l.toLowerCase().startsWith("subject:")).join("\n").trim());
        } else {
          setPreviewContent(pipelineResult.draft_text);
          setPreviewSubject(pipelineResult.suggested_subject || `${target === "next" ? nextLabel : followingLabel} for ${lead.company}`);
        }
      }
    } catch (err) {
      console.error("[NurturePreviewCard] Generation error:", err);
      toast.error("Failed to generate nurture draft");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSendNow = async (target: "next" | "following") => {
    setIsSending(true);
    try {
      // Trigger the automation executor for this lead by setting it eligible now
      await supabase
        .from("leads")
        .update({
          needs_action: true,
          eligible_at: new Date().toISOString(),
          next_action_key: `send_nurture_${nurtureSent + (target === "following" ? 2 : 1)}`,
          next_action_label: `Nurture email #${nurtureSent + (target === "following" ? 2 : 1)}`,
          action_reason_code: "NURTURE_DUE",
          nurture_mode: "automatic", // temporarily set to automatic so executor processes it
        })
        .eq("id", lead.id);

      // Invoke the automation executor directly
      const { error } = await supabase.functions.invoke("automation-executor", {});
      if (error) throw error;

      toast.success("Nurture email sent");
      onUpdate();
    } catch (err) {
      console.error("[NurturePreviewCard] Send now error:", err);
      toast.error("Failed to send nurture email");
      // Revert nurture_mode if it was review before
      if (mode === "review") {
        await supabase
          .from("leads")
          .update({ nurture_mode: "review" })
          .eq("id", lead.id);
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleApprove = async () => {
    if (!previewContent.trim()) return;
    setIsApproving(true);
    try {
      await saveDraft(lead.id, {
        channel: "email",
        draft_type: "nurture",
        to_recipient: lead.email,
        subject: previewSubject || undefined,
        body_text: previewContent,
        step_key: `nurture_${nurtureSent + (previewTarget === "following" ? 2 : 1)}`,
        nurture_theme: theme,
        nurture_cadence: lead.nurture_cadence || "biweekly",
        status: "approved",
      });

      toast.success("Nurture email approved and saved");
      setShowPreview(false);

      // After first manual approval, show upgrade prompt
      if (nurtureSent === 0 && mode === "review") {
        setShowUpgradePrompt(true);
      }

      onUpdate();
    } catch (err) {
      console.error("Failed to approve nurture email:", err);
      toast.error("Failed to save approved email");
    } finally {
      setIsApproving(false);
    }
  };

  const handlePause = async () => {
    setIsPausing(true);
    try {
      await supabase
        .from("leads")
        .update({
          nurture_status: "paused",
          needs_action: false,
          next_action_key: null,
          next_action_label: "Nurture paused",
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
      await supabase
        .from("leads")
        .update({
          nurture_status: "active",
          needs_action: true,
          next_action_label: "Review next nurture email",
          eligible_at: new Date().toISOString(),
        })
        .eq("id", lead.id);
      onUpdate();
    } finally {
      setIsPausing(false);
    }
  };

  const handleEnableAutomation = async () => {
    try {
      // Calculate next eligible_at based on cadence
      const cadence = lead.nurture_cadence || "biweekly";
      const days = CADENCE_DAYS[cadence] || 14;
      const base = lead.mode_changed_at ? new Date(lead.mode_changed_at) : new Date();
      const nextEligible = addDays(base, days * (nurtureSent + 1));
      nextEligible.setHours(9, 30, 0, 0);
      // If next eligible is in the past, schedule for tomorrow
      const now = new Date();
      const eligibleAt = nextEligible > now ? nextEligible : addDays(now, 1);
      if (nextEligible <= now) eligibleAt.setHours(9, 30, 0, 0);

      await supabase
        .from("leads")
        .update({
          nurture_mode: "automatic",
          needs_action: true,
          eligible_at: eligibleAt.toISOString(),
          next_action_key: `send_nurture_${nurtureSent + 1}`,
          next_action_label: `Nurture email #${nurtureSent + 1}`,
          action_reason_code: "NURTURE_DUE",
        })
        .eq("id", lead.id);
      toast.success("Nurture automation enabled — emails will send automatically");
      setShowUpgradeDialog(false);
      onUpdate();
    } catch {
      toast.error("Failed to enable automation");
    }
  };

  // ─── Re-engaged / Paused by system ───
  if (isReEngaged && status === "active") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Sprout className="h-3.5 w-3.5 text-emerald-500" />
          <span className="text-sm font-medium text-foreground">Nurture Paused</span>
        </div>
        <p className="text-xs text-muted-foreground">Lead re-engaged.</p>
      </div>
    );
  }

  // ─── Paused ───
  if (status === "paused") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Pause className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-sm font-medium text-foreground">Nurture Paused</span>
        </div>
        <p className="text-xs text-muted-foreground">Manually paused</p>
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
      </div>
    );
  }

  // ─── Active ───
  return (
    <>
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sprout className="h-3.5 w-3.5 text-emerald-500" />
            <span className="text-sm font-medium text-foreground">
              Nurture Mode
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 font-medium">
                {mode === "review" ? "Review" : "Auto"}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-medium">
              Active
            </span>
          </div>
        </div>

        {/* Meta */}
        <div className="text-xs text-muted-foreground">
          Theme: {THEME_LABELS[theme] || theme} · Cadence: Every {CADENCE_DAYS[lead.nurture_cadence || "biweekly"]} days
        </div>

        <Separator className="bg-border/40" />

        {/* Next Email */}
        <div className="space-y-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Next</span>
          <p className="text-sm font-semibold text-foreground">{nextLabel}</p>
          <p className="text-xs text-muted-foreground">
            {format(nextDate, "MMM d")} · {format(nextDate, "h:mm a")}
          </p>
        </div>

        {/* Following */}
        <div className="space-y-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Following</span>
          <p className="text-sm font-semibold text-foreground">{followingLabel}</p>
          <p className="text-xs text-muted-foreground">
            {format(followingDate, "MMM d")} · {format(followingDate, "h:mm a")}
          </p>
        </div>

        <Separator className="bg-border/40" />

        {/* Actions — only show preview/generate for review mode */}
        {mode === "review" && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleGenerateDraft("next")}
              className="flex-1 text-xs h-7"
            >
              <Eye className="h-3 w-3 mr-1" />
              Preview Next
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleGenerateDraft("following")}
              className="flex-1 text-xs h-7"
            >
              <Wand2 className="h-3 w-3 mr-1" />
              Generate Following
            </Button>
          </div>
        )}
        {mode === "automatic" && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
            <Zap className="h-3 w-3 inline mr-1" />
            Emails send automatically at cadence. No approval needed.
          </p>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePause}
          disabled={isPausing}
          className="w-full text-xs h-7 text-muted-foreground"
        >
          {isPausing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Pause className="h-3 w-3 mr-1" />}
          Pause
        </Button>

        {/* Switch to Auto mode */}
        {mode === "review" && (
          <>
            <Separator className="bg-border/40" />
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Emails require manual approval in Review mode. Switch to Auto to send on schedule.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowUpgradeDialog(true)}
                className="w-full text-xs h-7 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
              >
                <Zap className="h-3 w-3 mr-1" />
                Switch to Auto
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Preview Modal */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Sprout className="h-4 w-4 text-emerald-500" />
              {previewTarget === "next" ? "Preview" : "Generate"}: {previewTarget === "next" ? nextLabel : followingLabel}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Scheduled: {format(previewTarget === "next" ? nextDate : followingDate, "MMM d, yyyy · h:mm a")}
            </p>
            {isGenerating ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground ml-2">Generating draft…</span>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Subject</label>
                  <input
                    value={previewSubject}
                    onChange={(e) => setPreviewSubject(e.target.value)}
                    className="w-full text-sm border border-input bg-background rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="Email subject..."
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Body</label>
                  <Textarea
                    value={previewContent}
                    onChange={(e) => setPreviewContent(e.target.value)}
                    rows={10}
                    className="text-sm"
                    placeholder="Draft will appear here..."
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setShowPreview(false)}>
              Close
            </Button>
            <Button
              size="sm"
              onClick={handleApprove}
              disabled={isGenerating || isApproving || !previewContent.trim()}
            >
              {isApproving ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Saving...</>
              ) : (
                <><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve & Save</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upgrade to Automation Dialog */}
      <Dialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-primary" />
              Enable Nurture Automation?
            </DialogTitle>
            <DialogDescription className="text-xs">
              Emails will send automatically at cadence. System stops instantly on reply or meeting.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setShowUpgradeDialog(false)}>
              Keep Review Mode
            </Button>
            <Button size="sm" onClick={handleEnableAutomation}>
              <Zap className="h-3.5 w-3.5 mr-1" />
              Enable Automatic Sending
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
