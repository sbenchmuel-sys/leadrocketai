// ============================================================================
// Add selected leads to an outreach campaign (Unit A).
//
// Mirror of AddLeadsDialog but flipped: here the leads are already chosen and
// the rep picks which outreach to enroll them into. Reuses the same honest
// two-step flow — pick → preview plan (capacity + who'll be skipped) → enroll —
// and the same enrollment logic (previewEnrollment / enrollLeadsInCampaign), so
// the fail-closed opt-out / suppression / live-relationship gates all apply.
//
// Guardrail: enrollment lays down a *schedule*; it never sends. Sending stays
// behind the executor's consent gate.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertTriangle, ArrowLeft, Megaphone } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { fetchWorkspaceCampaigns, type Campaign } from "@/lib/campaignQueries";
import {
  previewEnrollment,
  enrollLeadsInCampaign,
  type EnrollmentPreview,
} from "@/lib/campaignEnrollment";

interface AddToAutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadIds: string[];
  /** Called after a successful enroll so the page can reload + clear selection. */
  onEnrolled: () => void;
}

type Phase = "pick" | "review";

export function AddToAutomationDialog({
  open,
  onOpenChange,
  leadIds,
  onEnrolled,
}: AddToAutomationDialogProps) {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [campaignId, setCampaignId] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("pick");
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<EnrollmentPreview | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  useEffect(() => {
    if (!open || !workspaceId) return;
    setPhase("pick");
    setPreview(null);
    setCampaignId(null);
    setLoading(true);
    fetchWorkspaceCampaigns(workspaceId)
      .then((rows) => setCampaigns(rows.filter((c) => c.status !== "completed")))
      .catch(() => toast.error("Couldn't load your outreach campaigns"))
      .finally(() => setLoading(false));
  }, [open, workspaceId]);

  const handleContinue = async () => {
    if (!campaignId) return;
    setPreviewing(true);
    try {
      const p = await previewEnrollment(campaignId, leadIds);
      setPreview(p);
      setPhase("review");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't build the plan");
    } finally {
      setPreviewing(false);
    }
  };

  const handleEnroll = async () => {
    if (!campaignId) return;
    setEnrolling(true);
    try {
      const result = await enrollLeadsInCampaign(campaignId, leadIds);
      if (result.enrolled === 0) {
        toast.info("No one new was enrolled — everyone selected was skipped.");
      } else {
        toast.success(
          `Added ${result.enrolled} ${result.enrolled === 1 ? "lead" : "leads"} to automation`,
        );
      }
      onEnrolled();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add those leads");
    } finally {
      setEnrolling(false);
    }
  };

  const skipLines = useMemo(() => {
    if (!preview) return [];
    const s = preview.skips;
    const lines: string[] = [];
    if (s.unsubscribed) lines.push(`${s.unsubscribed} opted out — won't be contacted`);
    if (s.suppressed) lines.push(`${s.suppressed} on your do-not-contact list`);
    if (s.alreadyEnrolled) lines.push(`${s.alreadyEnrolled} already in another outreach`);
    if (s.missingEmail) lines.push(`${s.missingEmail} have no email address`);
    if (s.activeOrCustomer)
      lines.push(
        `${s.activeOrCustomer} skipped — already a customer or closed deal, have a meeting booked, or recently replied`,
      );
    return lines;
  }, [preview]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {phase === "pick" ? (
          <>
            <DialogHeader>
              <DialogTitle>Add to automation</DialogTitle>
              <DialogDescription>
                Pick which outreach these {leadIds.length}{" "}
                {leadIds.length === 1 ? "lead" : "leads"} should go into.
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : campaigns.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <Megaphone className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    You don't have any outreach yet.
                  </p>
                  <Button
                    size="sm"
                    onClick={() => {
                      onOpenChange(false);
                      navigate("/app/automations/new");
                    }}
                  >
                    Create an outreach
                  </Button>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {campaigns.map((c) => (
                    <li key={c.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-accent">
                        <input
                          type="radio"
                          name="campaign"
                          className="h-4 w-4 accent-primary"
                          checked={campaignId === c.id}
                          onChange={() => setCampaignId(c.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {c.name}
                          </div>
                          <div className="truncate text-xs capitalize text-muted-foreground">
                            {c.status}
                          </div>
                        </div>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-end">
              <Button onClick={handleContinue} disabled={!campaignId || previewing}>
                {previewing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Here's the plan</DialogTitle>
              <DialogDescription>
                A quick, honest preview before anyone is enrolled.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-md border border-border p-3">
                <p className="text-sm font-medium text-foreground">
                  {preview?.enrollableCount ?? 0} of {leadIds.length}{" "}
                  {leadIds.length === 1 ? "lead" : "leads"} will be enrolled
                </p>
                {preview?.capacity?.summary && (
                  <p className="mt-1 text-xs text-muted-foreground">{preview.capacity.summary}</p>
                )}
              </div>

              {preview?.capacity?.warning && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{preview.capacity.warning}</AlertDescription>
                </Alert>
              )}

              {(skipLines.length > 0 || (preview?.channelSkips.lines.length ?? 0) > 0) && (
                <div className="space-y-1.5 text-xs text-muted-foreground">
                  {skipLines.map((line, i) => (
                    <p key={`skip-${i}`}>• {line}</p>
                  ))}
                  {preview?.channelSkips.lines.map((line, i) => (
                    <p key={`chan-${i}`}>• {line}</p>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPhase("pick")}
                disabled={enrolling}
              >
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
              </Button>
              <Button
                onClick={handleEnroll}
                disabled={enrolling || (preview?.enrollableCount ?? 0) === 0}
              >
                {enrolling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Enroll {preview?.enrollableCount ?? 0}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
