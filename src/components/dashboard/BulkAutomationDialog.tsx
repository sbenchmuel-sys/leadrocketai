import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Zap, Loader2, AlertTriangle, ShieldAlert, CheckCircle2 } from "lucide-react";
import { EnrichedLead, MOTION_LABELS, Motion } from "@/lib/dashboardUtils";
import { getMotionIntervals, getNurtureCadenceDays } from "@/lib/cadenceSettingsTypes";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { addDays } from "date-fns";

interface BulkAutomationDialogProps {
  selectedLeads: EnrichedLead[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type FlagReason = "has_replied" | "not_eligible_motion" | "closed" | "already_active";

interface CategorizedLead {
  lead: EnrichedLead;
  flags: { reason: FlagReason; label: string }[];
  eligible: boolean;
}

const FLAG_LABELS: Record<FlagReason, string> = {
  has_replied: "Has replied",
  not_eligible_motion: "Not eligible",
  closed: "Closed",
  already_active: "Already active",
};

const FLAG_COLORS: Record<FlagReason, string> = {
  has_replied: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  not_eligible_motion: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  closed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  already_active: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
};

function categorizeLead(lead: EnrichedLead): CategorizedLead {
  const flags: { reason: FlagReason; label: string }[] = [];

  if (lead.last_inbound_at && lead.motion !== "nurture") {
    flags.push({ reason: "has_replied", label: FLAG_LABELS.has_replied });
  }

  if (lead.stage === "closed_won" || lead.stage === "closed_lost") {
    flags.push({ reason: "closed", label: FLAG_LABELS.closed });
  } else if (lead.motion !== "outbound_prospecting" && lead.motion !== "inbound_response" && lead.motion !== "nurture") {
    flags.push({ reason: "not_eligible_motion", label: `${FLAG_LABELS.not_eligible_motion} (${MOTION_LABELS[lead.motion as Motion] || lead.motion})` });
  }

  const alreadyActive = !!(lead as any).eligible_at && lead.needs_action;
  if (alreadyActive) {
    flags.push({ reason: "already_active", label: FLAG_LABELS.already_active });
  }

  return { lead, flags, eligible: flags.length === 0 };
}

function computeAutomationFields(lead: EnrichedLead) {
  const motion = lead.motion || "outbound_prospecting";

  // Nurture-specific scheduling
  if (motion === "nurture") {
    const cadence = (lead as any).nurture_cadence || "biweekly";
    const gapDays = getNurtureCadenceDays(cadence);
    const stepNum = ((lead as any).nurture_outbound_count || 0) + 1;

    let eligibleAt = addDays(new Date(), gapDays);
    eligibleAt.setHours(9, 30, 0, 0);
    if (eligibleAt.getTime() <= Date.now()) {
      eligibleAt = addDays(eligibleAt, 1);
    }

    return {
      needs_action: true,
      next_action_key: `nurture_${stepNum}`,
      next_action_label: `Nurture Email ${stepNum}`,
      eligible_at: eligibleAt.toISOString(),
      action_reason_code: "NURTURE_DUE",
      nurture_status: "active",
      nurture_mode: (lead as any).nurture_mode || "review",
    };
  }

  // Outbound / Inbound scheduling
  const intervals = getMotionIntervals(motion);

  const STEP_LABELS: Record<string, string> = motion === "inbound_response"
    ? { send_pre_1: "Intro Reply", send_pre_2: "Follow-up 1", send_pre_3: "Follow-up 2" }
    : { send_pre_1: "Intro Email", send_pre_2: "Follow-up 1", send_pre_3: "Follow-up 2", send_pre_4: "Breakup Email" };

  const hasOutbound = !!lead.last_outbound_at;
  const nextKey = hasOutbound ? "send_pre_2" : "send_pre_1";
  const nextLabel = STEP_LABELS[nextKey] || "Intro Email";

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
    if (eligibleAt.getTime() <= Date.now()) {
      eligibleAt = addDays(eligibleAt, 1);
    }
  }

  return {
    needs_action: true,
    next_action_key: nextKey,
    next_action_label: nextLabel,
    eligible_at: eligibleAt.toISOString(),
    action_reason_code: "FOLLOWUP_DUE",
  };
}

export function BulkAutomationDialog({
  selectedLeads,
  open,
  onOpenChange,
  onSuccess,
}: BulkAutomationDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const categorized = useMemo(
    () => selectedLeads.map(categorizeLead),
    [selectedLeads]
  );

  const [checked, setChecked] = useState<Set<string>>(() => {
    return new Set(categorized.filter((c) => c.eligible).map((c) => c.lead.id));
  });

  // Reset checked state when dialog opens with new leads
  const leadIds = selectedLeads.map((l) => l.id).join(",");
  const [prevLeadIds, setPrevLeadIds] = useState(leadIds);
  if (leadIds !== prevLeadIds) {
    setPrevLeadIds(leadIds);
    setChecked(new Set(categorized.filter((c) => c.eligible).map((c) => c.lead.id)));
  }

  const eligibleChecked = categorized.filter(
    (c) => c.eligible && checked.has(c.lead.id)
  );

  const handleToggle = (id: string, value: boolean) => {
    const next = new Set(checked);
    if (value) next.add(id);
    else next.delete(id);
    setChecked(next);
  };

  const handleConfirm = async () => {
    if (eligibleChecked.length === 0) return;
    setIsSubmitting(true);

    try {
      // Process each lead individually since they may have different next_action_key/eligible_at
      const updates = eligibleChecked.map((c) => {
        const fields = computeAutomationFields(c.lead);
        return supabase
          .from("leads")
          .update(fields)
          .eq("id", c.lead.id);
      });

      const results = await Promise.all(updates);
      const errors = results.filter((r) => r.error);
      if (errors.length > 0) {
        console.error("Some updates failed:", errors);
        toast.error(`Failed to update ${errors.length} lead(s)`);
      } else {
        toast.success(`Automation enabled on ${eligibleChecked.length} lead${eligibleChecked.length > 1 ? "s" : ""}`);
      }

      onOpenChange(false);
      onSuccess();
    } catch (err) {
      console.error("Bulk automation failed:", err);
      toast.error("Failed to enable automation");
    } finally {
      setIsSubmitting(false);
    }
  };

  const eligibleCount = categorized.filter((c) => c.eligible).length;
  const flaggedCount = categorized.length - eligibleCount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            Enable Automation
          </DialogTitle>
          <DialogDescription>
            {eligibleChecked.length} of {selectedLeads.length} lead{selectedLeads.length > 1 ? "s" : ""} will be automated.
            {flaggedCount > 0 && ` ${flaggedCount} flagged.`}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[360px] -mx-2 px-2">
          <div className="space-y-1">
            {categorized.map((c) => (
              <label
                key={c.lead.id}
                className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50 cursor-pointer"
              >
                <Checkbox
                  checked={checked.has(c.lead.id)}
                  onCheckedChange={(v) => handleToggle(c.lead.id, !!v)}
                  disabled={!c.eligible}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {c.lead.name}
                    <span className="text-muted-foreground font-normal ml-1.5">
                      {c.lead.company}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {MOTION_LABELS[c.lead.motion as Motion] || c.lead.motion}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {c.flags.map((f) => (
                    <Badge
                      key={f.reason}
                      variant="outline"
                      className={`text-[10px] px-1.5 py-0 border-0 ${FLAG_COLORS[f.reason]}`}
                    >
                      {f.reason === "has_replied" && <AlertTriangle className="h-3 w-3 mr-0.5" />}
                      {(f.reason === "not_eligible_motion" || f.reason === "closed") && <ShieldAlert className="h-3 w-3 mr-0.5" />}
                      {f.reason === "already_active" && <CheckCircle2 className="h-3 w-3 mr-0.5" />}
                      {f.label}
                    </Badge>
                  ))}
                </div>
              </label>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isSubmitting || eligibleChecked.length === 0}
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Zap className="h-4 w-4 mr-2" />
            )}
            Enable ({eligibleChecked.length})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
