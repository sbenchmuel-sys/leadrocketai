// ============================================================
// ReEngagementCard — single primary action ("Draft re-engagement")
// for warm/inbound-sourced leads whose last outbound is newer than
// the prospect's last inbound. Visibility is gated by
// `isReEngagementCandidate` (a strict subset of the conditions
// under which playbookResolver returns "re_engagement_intro").
//
// Tapping the button triggers the existing `streamDraft` path
// (no new pipeline). Directly above the streamed draft we render
// one plain-English line summarizing what the draft is built on,
// sourced from the lead's pending milestones_json + deal_memory
// unanswered_questions.
//
// UI-only: this component does no routing, scoring, or send. The
// rep can copy or open the lead's Drafts tab to act on it.
// All touch targets are ≥44px; no hover-only controls.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { streamDraft } from "@/lib/generateDraft";
import {
  buildReEngagementSummaryLine,
  isReEngagementCandidate,
  type ReEngagementGateInput,
} from "@/lib/reEngagement";
import type { MilestoneItem } from "@/lib/supabaseQueries";

interface ReEngagementCardProps {
  leadId: string;
  gate: ReEngagementGateInput;
  /** Already-loaded milestones, when available (avoids an extra fetch). */
  milestones?: MilestoneItem[] | null;
  /** Compact = queue card context (less chrome). */
  compact?: boolean;
}

export default function ReEngagementCard({ leadId, gate, milestones, compact }: ReEngagementCardProps) {
  const eligible = useMemo(() => isReEngagementCandidate(gate), [gate]);

  const [loading, setLoading] = useState(false);
  const [draftText, setDraftText] = useState<string>("");
  const [subject, setSubject] = useState<string>("");
  const [unansweredQs, setUnansweredQs] = useState<string[]>([]);
  const [milestonesState, setMilestonesState] = useState<MilestoneItem[] | null>(milestones ?? null);
  const [opened, setOpened] = useState(false);

  // Fetch summary inputs lazily on first open (deal_memory + milestones)
  useEffect(() => {
    if (!opened || !leadId) return;
    let cancelled = false;
    (async () => {
      const [dmRes, leadRes] = await Promise.all([
        supabase.from("deal_memory").select("unanswered_questions").eq("lead_id", leadId).maybeSingle(),
        milestonesState === null
          ? supabase.from("leads").select("milestones_json").eq("id", leadId).maybeSingle()
          : Promise.resolve({ data: null, error: null } as { data: null; error: null }),
      ]);
      if (cancelled) return;
      const qs = (dmRes.data?.unanswered_questions as string[] | null) ?? [];
      setUnansweredQs(qs);
      const ms = (leadRes.data as { milestones_json?: unknown } | null)?.milestones_json;
      if (Array.isArray(ms)) {
        setMilestonesState(ms as unknown as MilestoneItem[]);
      }
    })();
    return () => { cancelled = true; };
  }, [opened, leadId, milestonesState]);

  if (!eligible) return null;

  const summaryLine = buildReEngagementSummaryLine({
    milestones: milestonesState,
    unanswered_questions: unansweredQs,
  });

  async function handleGenerate() {
    setLoading(true);
    setOpened(true);
    setDraftText("");
    setSubject("");
    try {
      let acc = "";
      await streamDraft({
        lead_id: leadId,
        channel: "email",
        onToken: (t) => {
          acc += t;
          setDraftText(acc);
        },
        onSubject: (s) => setSubject(s),
        onPipelineReady: () => {},
      });
    } catch (err) {
      console.error("[ReEngagementCard] streamDraft failed", err);
      toast.error("Couldn't generate the draft — try again");
    } finally {
      setLoading(false);
    }
  }

  const hasDraft = draftText.length > 0;

  return (
    <div className={compact ? "mt-2" : "mt-3 rounded-lg border border-border bg-card/40 p-3"}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void handleGenerate(); }}
          disabled={loading}
          className="min-h-[44px] gap-1.5"
          size="sm"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : hasDraft ? <RefreshCw className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
          {hasDraft ? "Regenerate" : "Draft re-engagement"}
        </Button>
      </div>

      {opened && (
        <div className="mt-3 space-y-2">
          {/* Plain-English context line — rendered directly ABOVE the draft. */}
          <p className="text-xs text-muted-foreground italic">{summaryLine}</p>

          {subject && (
            <div className="text-xs">
              <span className="text-muted-foreground">Subject: </span>
              <span className="font-medium text-foreground">{subject}</span>
            </div>
          )}

          <div className="rounded-md border border-border bg-background p-3 text-sm text-foreground whitespace-pre-wrap min-h-[88px]">
            {hasDraft ? draftText : loading ? "Generating…" : ""}
          </div>
        </div>
      )}
    </div>
  );
}
