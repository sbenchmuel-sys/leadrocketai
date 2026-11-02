// Lead Scout (Unit 4): "Start outreach" for leads DrivePilot found.
//
// One button → suggests the workspace's best-performing live cold outreach →
// confirm "Start '<name>'? You'll review every email before it sends."
// Enrollment goes through the existing enrollLeadsInCampaign (same opt-out /
// do-not-contact / already-enrolled / live-relationship / invalid-email guards
// and the transactional enroll_campaign_leads RPC). Review mode is enforced by
// only ever offering campaigns whose send_mode is 'review' (re-checked right
// before enrolling) — nothing here sends, and nothing enrolls without a click.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fetchWorkspaceCampaigns, type Campaign } from "@/lib/campaignQueries";
import { fetchCampaignScorecard } from "@/lib/campaignScorecardQueries";
import { enrollLeadsInCampaign } from "@/lib/campaignEnrollment";

export interface CadenceStats {
  enrolled: number;
  replied: number;
  meetings: number;
}

/** Below this many enrolled people a reply rate is noise; such cadences rank by use instead. */
export const MIN_CADENCE_SAMPLE = 10;

type CadenceLike = Pick<Campaign, "id" | "status" | "send_mode" | "motion">;

/** Live, review-mode, cold outbound outreach only: Scout leads never go into an auto-send cadence. */
export function eligibleCadences<T extends CadenceLike>(campaigns: T[]): T[] {
  return campaigns.filter(
    (c) => c.status === "active" && (c.send_mode ?? "review") === "review" && c.motion === "outbound_prospecting",
  );
}

/**
 * Best first. Cadences with ≥ MIN_CADENCE_SAMPLE enrolled rank by
 * (replies + meetings) / enrolled (get_campaign_scorecard); the rest follow,
 * most-used first. Ties keep the input order (newest campaign first).
 */
export function rankCadences<T extends { id: string }>(campaigns: T[], stats: Map<string, CadenceStats>): T[] {
  const enrolled = (c: T) => stats.get(c.id)?.enrolled ?? 0;
  const score = (c: T) => {
    const s = stats.get(c.id);
    return s && s.enrolled >= MIN_CADENCE_SAMPLE ? (s.replied + s.meetings) / s.enrolled : -1;
  };
  return campaigns
    .map((c, i) => ({ c, i }))
    .sort((a, b) => score(b.c) - score(a.c) || enrolled(b.c) - enrolled(a.c) || a.i - b.i)
    .map(({ c }) => c);
}

async function loadRankedCadences(workspaceId: string): Promise<Campaign[]> {
  const eligible = eligibleCadences(await fetchWorkspaceCampaigns(workspaceId));
  const stats = new Map<string, CadenceStats>();
  await Promise.all(eligible.map(async (c) => {
    try {
      const s = await fetchCampaignScorecard(workspaceId, c.id);
      if (s) stats.set(c.id, s);
    } catch { /* no stats → ranks by use (0) */ }
  }));
  return rankCadences(eligible, stats);
}

export function StartOutreachButton({
  leadIds,
  onEnrolled,
  size = "sm",
}: {
  leadIds: string[];
  onEnrolled?: () => void;
  size?: "sm" | "default";
}) {
  const { workspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Campaign[] | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const chosen = options?.find((c) => c.id === chosenId) ?? null;

  const begin = async () => {
    if (!workspaceId) return;
    setOpen(true);
    setOptions(null);
    setPicking(false);
    try {
      const ranked = await loadRankedCadences(workspaceId);
      setOptions(ranked);
      setChosenId(ranked[0]?.id ?? null);
    } catch {
      setOpen(false);
      toast.error("Couldn't load your outreach. Please try again.");
    }
  };

  const confirm = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      // Re-check right before enrolling: still live and still review mode.
      const { data } = await supabase.from("campaigns").select("id, status, send_mode, motion").eq("id", chosen.id).maybeSingle();
      if (!data || eligibleCadences([data as unknown as CadenceLike]).length === 0) {
        toast.error(`'${chosen.name}' no longer reviews emails before sending. Pick another outreach.`);
        return;
      }
      const res = await enrollLeadsInCampaign(chosen.id, leadIds);
      if (res.enrolled === 0) {
        toast.info("Not started: already in an outreach, opted out, on your do-not-contact list, no valid email, or already talking to you.");
      } else {
        const who = leadIds.length === 1 ? "" : ` for ${res.enrolled} of ${leadIds.length} leads`;
        toast.success(`Started '${chosen.name}'${who}. Each email waits for your review.`);
        onEnrolled?.();
      }
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start outreach");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size={size} onClick={() => void begin()}>Start outreach</Button>
      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent>
          {options === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
            </div>
          ) : !chosen ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>No outreach to start yet</AlertDialogTitle>
                <AlertDialogDescription>
                  You need a live cold outreach that lets you review emails before they send.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Close</AlertDialogCancel>
                <AlertDialogAction asChild>
                  <Link to="/app/automations/new">Create an outreach</Link>
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Start '{chosen.name}'?</AlertDialogTitle>
                <AlertDialogDescription>You'll review every email before it sends.</AlertDialogDescription>
              </AlertDialogHeader>
              {options.length > 1 && (picking ? (
                <ul className="max-h-60 divide-y overflow-y-auto rounded-md border">
                  {options.map((c) => (
                    <li key={c.id}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent">
                        <input
                          type="radio"
                          name="scout-outreach"
                          className="h-4 w-4 accent-primary"
                          checked={chosenId === c.id}
                          onChange={() => setChosenId(c.id)}
                        />
                        <span className="truncate">{c.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <Button variant="link" className="h-auto justify-start p-0" onClick={() => setPicking(true)}>
                  Choose a different outreach
                </Button>
              ))}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <Button disabled={busy} onClick={() => void confirm()}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Start
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Lead Detail: shown for ai_scout leads that aren't opted out or already in an outreach. */
export function ScoutStartOutreach({
  lead,
  onEnrolled,
}: {
  lead: { id: string; source_type?: string | null; unsubscribed?: boolean | null; automation_mode?: string | null };
  onEnrolled?: () => void;
}) {
  const [inOutreach, setInOutreach] = useState<boolean | null>(null);
  const eligible = lead.source_type === "ai_scout" && lead.unsubscribed !== true && !lead.automation_mode;
  useEffect(() => {
    setInOutreach(null);
    if (!eligible) return;
    let live = true;
    void supabase.from("leads").select("campaign_id").eq("id", lead.id).maybeSingle()
      .then(({ data, error }) => { if (live) setInOutreach(error ? true : !!data?.campaign_id); });
    return () => { live = false; };
  }, [lead.id, eligible]);
  if (!eligible || inOutreach !== false) return null;
  return (
    <StartOutreachButton
      leadIds={[lead.id]}
      onEnrolled={() => {
        setInOutreach(true);
        onEnrolled?.();
      }}
    />
  );
}
