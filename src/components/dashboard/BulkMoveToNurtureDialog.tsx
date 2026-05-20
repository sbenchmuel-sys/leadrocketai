import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Leaf, Loader2, AlertTriangle } from "lucide-react";
import { EnrichedLead, MOTION_LABELS, Motion } from "@/lib/dashboardUtils";
import { categorizeForNurtureMove } from "@/lib/leadEligibility";
import { getNurtureCadenceDays } from "@/lib/cadenceSettingsTypes";
import { supabase } from "@/integrations/supabase/client";
import { insertSystemNote } from "@/lib/supabaseQueries";
import { toast } from "sonner";

interface BulkMoveToNurtureDialogProps {
  selectedLeads: EnrichedLead[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const SYSTEM_NOTE_SOURCE = "bulk_move_to_nurture_dialog";

function computeNurtureFields(): {
  motion: "nurture";
  nurture_status: "active";
  nurture_mode: "review";
  nurture_cadence: "biweekly";
  needs_action: false;
  next_action_key: "nurture_1";
  next_action_label: "Nurture Email 1";
  eligible_at: string;
  action_reason_code: "NURTURE_DUE";
  mode_changed_at: string;
} {
  const gapDays = getNurtureCadenceDays("biweekly");
  const eligibleAt = new Date();
  eligibleAt.setDate(eligibleAt.getDate() + gapDays);
  eligibleAt.setHours(9, 30, 0, 0);
  if (eligibleAt.getTime() <= Date.now()) {
    eligibleAt.setDate(eligibleAt.getDate() + 1);
  }
  return {
    motion: "nurture",
    nurture_status: "active",
    nurture_mode: "review",
    nurture_cadence: "biweekly",
    needs_action: false,
    next_action_key: "nurture_1",
    next_action_label: "Nurture Email 1",
    eligible_at: eligibleAt.toISOString(),
    action_reason_code: "NURTURE_DUE",
    mode_changed_at: new Date().toISOString(),
  };
}

export function BulkMoveToNurtureDialog({
  selectedLeads,
  open,
  onOpenChange,
  onSuccess,
}: BulkMoveToNurtureDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const categorized = useMemo(
    () => selectedLeads.map(categorizeForNurtureMove),
    [selectedLeads],
  );

  const eligible = categorized.filter((c) => c.eligible);
  const blocked = categorized.filter((c) => !c.eligible);
  const total = categorized.length;
  const eligibleCount = eligible.length;
  const blockedCount = blocked.length;

  const runMove = async (mode: "all" | "eligible_only") => {
    if (total === 0) return;
    const targets = mode === "all" ? categorized : eligible;
    if (targets.length === 0) return;

    setIsSubmitting(true);
    try {
      const nurtureFields = computeNurtureFields();

      // Best-effort rep attribution for the audit-trail body. RLS already
      // associates the row with the workspace and auth_id; this is the
      // human-readable string a reviewer will read.
      let repLabel = "user";
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user?.email) repLabel = user.email;

      const updates = targets.map((c) => {
        // For BLOCKED leads on the Move-all path, clear the executor
        // consent gate at the same time as the motion flip — otherwise
        // a `full_auto` outbound lead would have its consent gate still
        // armed after the motion change and the executor would keep
        // firing until the next sync recomputes state.
        const isBlocked = !c.eligible;
        const extra: { automation_mode?: string | null } = isBlocked
          ? { automation_mode: null }
          : {};
        return supabase
          .from("leads")
          .update({ ...nurtureFields, ...extra })
          .eq("id", c.lead.id);
      });

      const results = await Promise.all(updates);
      const errors = results.filter((r) => r.error);

      // Audit trail — one system_note per lead whose UPDATE succeeded.
      // Notes are best-effort: a failed note must not roll back the
      // mutation (the lead state change has already happened) but ops
      // can re-emit retroactively if needed.
      const noteWrites = targets
        .map((c, i) => {
          if (results[i].error) return null;
          const body = c.eligible
            ? `Moved to Nurture (bulk action) by ${repLabel}`
            : `Sequence paused: bulk move to nurture by ${repLabel}`;
          return insertSystemNote(c.lead.id, body, SYSTEM_NOTE_SOURCE);
        })
        .filter((p): p is Promise<{ id: string } | null> => p !== null);

      const noteResults = await Promise.allSettled(noteWrites);
      const noteFailures = noteResults.filter(
        (r) => r.status === "rejected",
      ).length;
      if (noteFailures > 0) {
        console.error(
          `bulk-move-to-nurture: ${noteFailures} system_note write(s) failed`,
        );
      }

      if (errors.length > 0) {
        toast.error(
          `Failed to update ${errors.length} of ${targets.length} lead${
            targets.length > 1 ? "s" : ""
          }`,
        );
      } else if (mode === "all" && blockedCount > 0) {
        toast.success(
          `${targets.length} moved to Nurture (${blockedCount} active sequence${
            blockedCount === 1 ? "" : "s"
          } paused)`,
        );
      } else if (mode === "eligible_only" && blockedCount > 0) {
        toast.success(
          `${targets.length} moved to Nurture (${blockedCount} skipped)`,
        );
      } else {
        toast.success(
          `${targets.length} lead${
            targets.length > 1 ? "s" : ""
          } moved to Nurture`,
        );
      }

      onOpenChange(false);
      onSuccess();
    } catch (err) {
      console.error("Bulk move-to-nurture failed:", err);
      toast.error("Failed to move leads to nurture");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Show blocked leads first so the at-risk rows are above the fold.
  const orderedForDisplay = [...blocked, ...eligible];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Leaf className="h-5 w-5 text-teal-600" />
            Move {total} lead{total === 1 ? "" : "s"} to Nurture?
          </DialogTitle>
          <DialogDescription>
            {blockedCount === 0 ? (
              <>
                All {eligibleCount} selected lead
                {eligibleCount === 1 ? "" : "s"} will move to nurture cleanly.
                Each will be switched to the biweekly cadence in review mode.
              </>
            ) : (
              <>
                <strong>{eligibleCount}</strong> of <strong>{total}</strong>{" "}
                lead{total === 1 ? "" : "s"} will move to nurture cleanly.{" "}
                <strong>{blockedCount}</strong>{" "}
                {blockedCount === 1 ? "has" : "have"} active outbound sequences
                that will be paused if you proceed.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[300px] -mx-2 px-2">
          <div className="space-y-1">
            {orderedForDisplay.map((c) => (
              <div
                key={c.lead.id}
                className="flex items-center gap-3 rounded-md px-2 py-2"
              >
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
                {!c.eligible && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 border-0 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                  >
                    <AlertTriangle className="h-3 w-3 mr-0.5" />
                    Active outbound sequence
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>

        <Separator />

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          {blockedCount > 0 && (
            <Button
              variant="outline"
              onClick={() => runMove("eligible_only")}
              disabled={isSubmitting || eligibleCount === 0}
            >
              Move only the {eligibleCount} eligible
            </Button>
          )}
          <Button
            onClick={() => runMove("all")}
            disabled={isSubmitting || total === 0}
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Leaf className="h-4 w-4 mr-2" />
            )}
            {blockedCount > 0
              ? `Move all (pause ${blockedCount} active sequence${
                  blockedCount === 1 ? "" : "s"
                })`
              : `Move ${total}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
