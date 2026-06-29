// ============================================================
// ReEngagementCard — single primary action ("Draft re-engagement")
// for warm/inbound-sourced leads whose last outbound is newer than
// the prospect's last inbound. Visibility is gated by
// `isReEngagementCandidate` (a strict subset of the conditions
// under which playbookResolver returns "re_engagement_intro").
//
// Tap → generates a draft via the existing `useBackgroundDraftQueue`
// pipeline (same one the dashboard / queue pre-generate button uses),
// then opens `EmailActionDialog` with the subject + body prefilled.
// The dialog is the existing confirm-before-send composer; we do NOT
// build a new send path here.
//
// A plain-English context line — sourced from milestones_json +
// deal_memory.unanswered_questions — is shown above the button so
// the rep knows what the draft will be built on.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { EmailActionDialog } from "@/components/dashboard/EmailActionDialog";
import { useBackgroundDraftQueue } from "@/hooks/useBackgroundDraftQueue";
import {
  buildReEngagementSummaryLine,
  isReEngagementCandidate,
  type ReEngagementGateInput,
} from "@/lib/reEngagement";
import type { MilestoneItem } from "@/lib/supabaseQueries";

// Minimal lead shape required by EmailActionDialog. Kept loose so callers
// can pass QueueLeadRow or LeadDetail without conversion.
export interface ReEngagementLead {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  stage: string | null;
  motion?: string | null;
  next_action_key?: string | null;
  next_action_label?: string | null;
  job_title?: string | null;
  industry?: string | null;
}

interface ReEngagementCardProps {
  lead: ReEngagementLead;
  gate: ReEngagementGateInput;
  /** Already-loaded milestones, when available (avoids an extra fetch). */
  milestones?: MilestoneItem[] | null;
  /** Compact = queue card context (less chrome). */
  compact?: boolean;
}

export default function ReEngagementCard({ lead, gate, milestones, compact }: ReEngagementCardProps) {
  const eligible = useMemo(() => isReEngagementCandidate(gate), [gate]);

  const { enqueue, getStatus, consume } = useBackgroundDraftQueue();
  const draftStatus = getStatus(lead.id);

  const [waitingForReady, setWaitingForReady] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [prefilled, setPrefilled] = useState<{ subject: string; body: string } | null>(null);

  const [unansweredQs, setUnansweredQs] = useState<string[]>([]);
  const [milestonesState, setMilestonesState] = useState<MilestoneItem[] | null>(milestones ?? null);

  // Lazily load context inputs for the summary line (once per mount).
  useEffect(() => {
    if (!eligible || !lead.id) return;
    let cancelled = false;
    (async () => {
      const [dmRes, leadRes] = await Promise.all([
        supabase.from("deal_memory").select("unanswered_questions").eq("lead_id", lead.id).maybeSingle(),
        milestonesState === null
          ? supabase.from("leads").select("milestones_json").eq("id", lead.id).maybeSingle()
          : Promise.resolve({ data: null, error: null } as { data: null; error: null }),
      ]);
      if (cancelled) return;
      const qs = (dmRes.data?.unanswered_questions as string[] | null) ?? [];
      setUnansweredQs(qs);
      const ms = (leadRes.data as { milestones_json?: unknown } | null)?.milestones_json;
      if (Array.isArray(ms)) setMilestonesState(ms as unknown as MilestoneItem[]);
    })();
    return () => { cancelled = true; };
  }, [eligible, lead.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the background draft becomes ready after the user tapped the
  // button, auto-consume and open the composer dialog.
  useEffect(() => {
    if (!waitingForReady) return;
    if (draftStatus?.status === "ready") {
      const entry = consume(lead.id);
      if (entry?.result) {
        setPrefilled({
          subject: entry.result.suggested_subject || entry.subject || "",
          body: entry.result.draft_text || "",
        });
        setDialogOpen(true);
      }
      setWaitingForReady(false);
    } else if (draftStatus?.status === "error") {
      toast.error("Couldn't generate the draft — try again");
      setWaitingForReady(false);
    }
  }, [draftStatus, waitingForReady, consume, lead.id]);

  if (!eligible) return null;

  const summaryLine = buildReEngagementSummaryLine({
    milestones: milestonesState,
    unanswered_questions: unansweredQs,
  });

  const generating = waitingForReady || draftStatus?.status === "generating";

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (generating) return;
    setWaitingForReady(true);
    void enqueue(lead.id);
  }

  return (
    <div className={compact ? "mt-2" : "mt-3 rounded-lg border border-border bg-card/40 p-3"}>
      <p className="text-xs text-muted-foreground italic mb-2">{summaryLine}</p>
      <Button
        type="button"
        onClick={handleClick}
        disabled={generating}
        className="min-h-[44px] gap-1.5"
        size="sm"
      >
        {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
        {generating ? "Drafting…" : "Draft re-engagement"}
      </Button>

      {dialogOpen && prefilled && (
        <EmailActionDialog
          lead={{
            id: lead.id,
            name: lead.name,
            company: lead.company ?? "",
            email: lead.email ?? "",
            stage: lead.stage ?? "",
            motion: lead.motion ?? undefined,
            next_action_key: lead.next_action_key ?? null,
            next_action_label: lead.next_action_label ?? null,
            job_title: lead.job_title ?? null,
            industry: lead.industry ?? null,
          }}
          open={dialogOpen}
          prefilledSubject={prefilled.subject}
          prefilledBody={prefilled.body}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) setPrefilled(null);
          }}
        />
      )}
    </div>
  );
}
