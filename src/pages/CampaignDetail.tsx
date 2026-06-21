import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  ChevronDown,
  MoreHorizontal,
  Trash2,
  UserPlus,
  Users,
  X,
  Loader2,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchCampaignById,
  fetchCampaignLeads,
  fetchCampaignCollateral,
  updateCampaign,
  deleteCampaign,
  type CampaignWithSteps,
  type CampaignLead,
  type SendMode,
  type CampaignCollateral,
} from "@/lib/campaignQueries";
import { pauseCampaign, resumeCampaign } from "@/lib/outreachQueue";
import { unenrollLeadFromCampaign } from "@/lib/campaignEnrollment";
import { CampaignScript } from "@/components/automations/CampaignScript";
import { CampaignContentReview } from "@/components/automations/CampaignContentReview";
import { CampaignCollateralSection } from "@/components/automations/CampaignCollateralSection";
import { AddLeadsDialog } from "@/components/automations/AddLeadsDialog";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Finished",
};

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [campaign, setCampaign] = useState<CampaignWithSteps | null>(null);
  const [people, setPeople] = useState<CampaignLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [collateral, setCollateral] = useState<CampaignCollateral[]>([]);
  // The campaign currently shown — guards against a stale collateral fetch from a
  // previously-viewed campaign resolving after navigation and writing wrong-
  // campaign rows into state (children filter by type/variant, not campaign_id).
  const shownCampaignId = useRef<string | undefined>(undefined);

  const loadPeople = useCallback(() => {
    if (!id) return;
    fetchCampaignLeads(id).then(setPeople).catch(() => {});
  }, [id]);

  // Collateral is owned here so the Collateral section and the email-review
  // section share one source of truth (a link made in one shows in the other).
  const loadCollateral = useCallback(() => {
    if (!id) return;
    fetchCampaignCollateral(id)
      .then((rows) => {
        if (shownCampaignId.current === id) setCollateral(rows);
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!id) return;
    // Mark the active campaign and drop the previous one's collateral immediately
    // so nothing from another campaign lingers while the new fetch is in flight.
    shownCampaignId.current = id;
    setCollateral([]);
    setLoading(true);
    fetchCampaignById(id)
      .then((c) => {
        setCampaign(c);
        setInstructions(c?.global_instructions ?? "");
      })
      .catch(() => toast.error("Couldn't load this outreach"))
      .finally(() => setLoading(false));
    loadPeople();
    loadCollateral();
  }, [id, loadPeople, loadCollateral]);

  const handleSaveInstructions = async () => {
    if (!id) return;
    setSavingInstructions(true);
    try {
      await updateCampaign(id, { global_instructions: instructions });
      toast.success("Instructions saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSavingInstructions(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    try {
      await deleteCampaign(id);
      toast.success("Outreach deleted");
      navigate("/app/automations");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete");
    }
  };

  const handleRemovePerson = async (leadId: string) => {
    if (!id) return;
    try {
      // Stop their schedule (delete enrollment → touches cascade) AND clear
      // campaign_id — clearing campaign_id alone would leave the cadence running.
      await unenrollLeadFromCampaign(id, leadId);
      setPeople((prev) => prev.filter((p) => p.id !== leadId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that person");
    }
  };

  // ── Sending controls (Unit C) ──
  const applySendMode = async (mode: SendMode) => {
    if (!id || !campaign) return;
    try {
      await updateCampaign(id, { send_mode: mode });
      setCampaign({ ...campaign, send_mode: mode });
      toast.success(mode === "automatic" ? "Emails will send automatically" : "You'll approve each email");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update sending");
    }
  };
  const handleSelectMode = (mode: SendMode) => {
    if (mode === "automatic" && campaign?.send_mode !== "automatic") {
      setConfirmAuto(true); // one honest confirm before turning auto-send on
      return;
    }
    if (mode !== campaign?.send_mode) void applySendMode(mode);
  };
  const handleTogglePause = async () => {
    if (!id || !campaign) return;
    // Only toggle between active↔paused. Draft/completed must NOT be flippable here
    // — otherwise Pause-then-Resume would activate a draft (bypassing launch checks)
    // or resurrect a completed outreach.
    if (campaign.status !== "active" && campaign.status !== "paused") return;
    setStatusBusy(true);
    try {
      if (campaign.status === "paused") {
        await resumeCampaign(id);
        setCampaign({ ...campaign, status: "active" });
        toast.success("Outreach resumed");
      } else {
        await pauseCampaign(id);
        setCampaign({ ...campaign, status: "paused" });
        toast.success("Outreach paused — all sending stopped");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change status");
    } finally {
      setStatusBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="text-muted-foreground">This outreach couldn't be found.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/app/automations")}>
          Back to outreach
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/app/automations")}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-bold text-foreground">{campaign.name}</h1>
            <Badge variant="secondary" className="text-xs font-normal">
              {STATUS_LABEL[campaign.status] ?? campaign.status}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {campaign.campaign_type === "industry" ? "Tailored by industry" : "For everyone"}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete outreach
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Sending controls */}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div>
            <p className="text-sm font-medium text-foreground">Sending</p>
            <div className="mt-2 inline-flex rounded-md border border-border p-0.5">
              <Button
                size="sm"
                variant={campaign.send_mode !== "automatic" ? "default" : "ghost"}
                className="h-7 text-xs"
                onClick={() => handleSelectMode("review")}
              >
                I approve each email
              </Button>
              <Button
                size="sm"
                variant={campaign.send_mode === "automatic" ? "default" : "ghost"}
                className="h-7 text-xs"
                onClick={() => handleSelectMode("automatic")}
              >
                Send automatically
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {campaign.send_mode === "automatic"
                ? "Emails send on schedule with all the usual safety checks. Calls and texts are always yours to do."
                : "Each email waits in your Outreach list for you to send. Calls and texts are yours to do."}
            </p>
          </div>
          {/* Pause/Resume only applies to a live (active or paused) outreach —
              hidden for drafts (not launched) and completed (finished). */}
          {(campaign.status === "active" || campaign.status === "paused") && (
          <div className="flex items-center justify-between border-t border-border pt-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {campaign.status === "paused" ? "Paused" : "Running"}
              </p>
              <p className="text-xs text-muted-foreground">
                Pausing stops every touch for everyone in this outreach.
              </p>
            </div>
            <Button
              size="sm"
              variant={campaign.status === "paused" ? "default" : "outline"}
              className="h-8 text-xs"
              disabled={statusBusy}
              onClick={handleTogglePause}
            >
              {statusBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {campaign.status === "paused" ? "Resume" : "Pause"}
            </Button>
          </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmAuto} onOpenChange={setConfirmAuto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send these emails automatically?</AlertDialogTitle>
            <AlertDialogDescription>
              DrivePilot will send each email on schedule — you won't approve them one by one.
              All the usual safety checks still apply, and calls and texts stay yours to do.
              You can switch back anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep approving</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmAuto(false); void applySendMode("automatic"); }}>
              Send automatically
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The script */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">The messages</h2>
        {campaign.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages in this outreach.</p>
        ) : (
          <CampaignScript
            steps={campaign.steps.map((s) => ({
              channel: s.channel,
              delay_days: s.delay_days,
              custom_instructions: s.custom_instructions,
              step_type: s.step_type,
            }))}
          />
        )}

        {/* Edit instructions */}
        <Collapsible open={instructionsOpen} onOpenChange={setInstructionsOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            Edit instructions
            <ChevronDown
              className={`ml-auto h-3.5 w-3.5 transition-transform ${instructionsOpen ? "rotate-180" : ""}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={6}
              className="resize-none text-sm"
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={handleSaveInstructions} disabled={savingInstructions}>
                {savingInstructions ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>

      {/* Full-cadence generated script (Unit B Phase 2) */}
      {campaign.steps.length > 0 && (
        <CampaignContentReview campaign={campaign} people={people} collateral={collateral} />
      )}

      {/* Collateral (Unit D) */}
      <CampaignCollateralSection
        campaign={campaign}
        people={people}
        collateral={collateral}
        onChanged={loadCollateral}
      />

      {/* People */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">
            People {people.length > 0 && <span className="text-muted-foreground">({people.length})</span>}
          </h2>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Add people
          </Button>
        </div>

        {people.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <Users className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No one's in this outreach yet. Add people whenever you're ready.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-2">
              <ul className="divide-y divide-border">
                {people.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{p.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {[p.company, p.email].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemovePerson(p.id)}
                      aria-label={`Remove ${p.name}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      <AddLeadsDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        campaignId={campaign.id}
        excludeIds={people.map((p) => p.id)}
        onAdded={loadPeople}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this outreach?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the outreach and its messages. The people in it stay as leads —
              they're just no longer part of this outreach. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
