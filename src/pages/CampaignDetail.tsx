import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  AlertTriangle,
  Settings as SettingsIcon,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchCampaignById,
  fetchCampaignLeads,
  fetchCampaignCollateral,
  updateCampaign,
  deleteCampaign,
  replaceCampaignStepsReconciled,
  campaignHasCadenceRows,
  type CampaignWithSteps,
  type CampaignStep,
  type CampaignLead,
  type SendMode,
  type CampaignCollateral,
  type ReconcileCampaignStep,
} from "@/lib/campaignQueries";
import { pauseCampaign, resumeCampaign, launchCampaign } from "@/lib/outreachQueue";
import { unenrollLeadFromCampaign } from "@/lib/campaignEnrollment";
import {
  insertStep,
  removeStep,
  moveStep,
  changeStepChannel,
  setStepGap,
  setStepMeetingCta,
  type DraftStep,
} from "@/lib/campaignDefaults";
import { canEditCampaignSteps, effectiveOrigStepNumber } from "@/lib/campaignStepReconcile";
import { supabase } from "@/integrations/supabase/client";
import type { CanonicalChannel } from "@/lib/channels";
import { CampaignScript } from "@/components/automations/CampaignScript";
import { CampaignContentReview } from "@/components/automations/CampaignContentReview";
import { CampaignCollateralSection } from "@/components/automations/CampaignCollateralSection";
import { AddLeadsDialog } from "@/components/automations/AddLeadsDialog";
import {
  fetchColdSendFloor,
  describeColdSendFloor,
  type ColdSendFloor,
} from "@/lib/coldSendFloor";

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
  // ── Structural step editing (draft-only) ──
  // Whether this campaign already has live cadence rows (enrollments/touches).
  // Drafts have none; once it does, renumbering would corrupt in-flight sends,
  // so the editor is hidden and the read-only script is kept. null = unknown yet.
  const [hasCadenceRows, setHasCadenceRows] = useState<boolean | null>(null);
  const [editingSteps, setEditingSteps] = useState(false);
  // The working copy while editing. Carries each touch's orig_step_number so the
  // reconciling save can move its generated copy/links to the new number.
  const [draftPlan, setDraftPlan] = useState<DraftStep[]>([]);
  const [savingSteps, setSavingSteps] = useState(false);
  const [confirmStepsSave, setConfirmStepsSave] = useState(false);
  // Whether the workspace can send texts — gates the SMS add/change options and
  // flags any existing text touch that still needs setup. Mirrors NewCampaign.
  const [smsEnabled, setSmsEnabled] = useState(false);
  // Bumped after a successful step save to remount the content/collateral
  // sections so they re-fetch the reconciled rows.
  const [stepsRev, setStepsRev] = useState(0);
  // Workspace cold-send floor — drives the plain-language "why automatic isn't
  // firing" note under the Sending control. null until loaded.
  const [floor, setFloor] = useState<ColdSendFloor | null>(null);
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

  // Load the workspace cold-send floor once the campaign (and its workspace) is
  // known, so we can honestly explain when "Send automatically" won't actually
  // fire. Best-effort: a failed read just leaves the note hidden.
  useEffect(() => {
    const workspaceId = campaign?.workspace_id;
    if (!workspaceId) return;
    let cancelled = false;
    fetchColdSendFloor(workspaceId)
      .then((f) => {
        if (!cancelled) setFloor(f);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [campaign?.workspace_id]);

  // Re-read whether the campaign has live cadence rows (enrollments/touches).
  // Called on load AND after Add/Remove people, so enrolling on this same page
  // immediately locks "Edit the steps" instead of letting the rep edit into a
  // save the RPC would reject.
  const refreshCadenceGate = useCallback(() => {
    if (!id) return;
    campaignHasCadenceRows(id)
      .then((has) => {
        setHasCadenceRows(has);
        if (has) setEditingSteps(false); // people got enrolled — lock editing now
      })
      .catch(() => setHasCadenceRows(true)); // fail closed
  }, [id]);

  // Is this campaign safe to structurally edit? Load the gate, and reset any
  // in-progress edit when we switch campaign.
  useEffect(() => {
    if (!id) return;
    setEditingSteps(false);
    setHasCadenceRows(null);
    refreshCadenceGate();
  }, [id, refreshCadenceGate]);

  // SMS capability for the editor (gates add/change-to-text and the "needs
  // setup" flag). Best-effort; defaults to off.
  useEffect(() => {
    const workspaceId = campaign?.workspace_id;
    if (!workspaceId) return;
    let cancelled = false;
    supabase
      .from("workspaces")
      .select("sms_enabled")
      .eq("id", workspaceId)
      .single()
      .then(({ data }) => { if (!cancelled) setSmsEnabled(data?.sms_enabled ?? false); });
    return () => { cancelled = true; };
  }, [campaign?.workspace_id]);

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
      refreshCadenceGate(); // removing the last enrolled person may re-open editing
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

  // ── Structural step editing (draft-only) ──
  // Project saved steps into the editor's working plan, stamping each touch's
  // current step_number as its identity so the reconciling save can carry its
  // copy/links to the new number.
  const toDraftPlan = (steps: CampaignStep[]): DraftStep[] =>
    steps.map((s) => ({
      step_number: s.step_number,
      step_type: s.step_type,
      channel: s.channel,
      delay_days: s.delay_days,
      cta_type: s.cta_type,
      custom_instructions: s.custom_instructions ?? "",
      active: s.active,
      include_meeting_cta: s.include_meeting_cta ?? null,
      orig_step_number: s.step_number,
      orig_channel: s.channel,
    }));

  const startEditingSteps = () => {
    if (!campaign) return;
    setDraftPlan(toDraftPlan(campaign.steps));
    setEditingSteps(true);
  };
  const cancelEditingSteps = () => {
    setEditingSteps(false);
    setDraftPlan([]);
  };

  // All structural mutations go through the same tested pure helpers the
  // new-campaign builder uses — never a forked editor. They preserve each
  // touch's orig_step_number (extra fields ride through the spreads).
  const onChangeDelay = (index: number, delayDays: number) =>
    setDraftPlan((p) => setStepGap(p, index, delayDays));
  const onRemove = (index: number) => setDraftPlan((p) => removeStep(p, index));
  const onMove = (index: number, dir: -1 | 1) => setDraftPlan((p) => moveStep(p, index, dir));
  const onChangeChannel = (index: number, channel: CanonicalChannel) =>
    setDraftPlan((p) => changeStepChannel(p, index, channel));
  const onInsert = (atIndex: number, channel: CanonicalChannel) =>
    setDraftPlan((p) => insertStep(p, atIndex, channel));
  const onToggleMeeting = (index: number, value: boolean) =>
    setDraftPlan((p) => setStepMeetingCta(p, index, value));

  const doSaveSteps = async () => {
    if (!id || !campaign) return;
    setConfirmStepsSave(false);
    setSavingSteps(true);
    try {
      const payload: ReconcileCampaignStep[] = draftPlan.map((s) => ({
        step_number: s.step_number,
        step_type: s.step_type,
        channel: s.channel,
        delay_days: s.delay_days,
        cta_type: s.cta_type,
        custom_instructions: s.custom_instructions,
        active: s.active,
        include_meeting_cta: s.include_meeting_cta ?? null,
        variant_group: null,
        // effective identity: a step whose channel no longer matches its saved
        // copy sends null (copy dropped, starts blank); an undone channel change
        // restores the original number so its copy is preserved.
        orig_step_number: effectiveOrigStepNumber(s),
      }));
      await replaceCampaignStepsReconciled(id, payload);
      // Reload the campaign so the read-only script + content sections reflect
      // the renumbered steps, and remount the dependents so they re-fetch the
      // reconciled copy/links.
      const fresh = await fetchCampaignById(id);
      setCampaign(fresh);
      setStepsRev((n) => n + 1);
      loadCollateral();
      setEditingSteps(false);
      setDraftPlan([]);
      toast.success("Steps updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save your changes");
    } finally {
      setSavingSteps(false);
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

  const floorStatus = floor ? describeColdSendFloor(floor) : null;
  // Structural step edits are draft-only and never while live cadence rows
  // exist. Treat "unknown" (still loading) as not-yet-editable. The RPC enforces
  // the same rule server-side.
  const canEditSteps = canEditCampaignSteps(campaign.status, hasCadenceRows !== false);

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
            <p className="text-xs text-muted-foreground">
              Choose how each email goes out. You can switch this anytime.
            </p>
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

            {/* Honest "dead switch" guard: automatic is selected, but the
                workspace floor isn't met, so nothing will actually send yet.
                Spell out what's missing in plain language with a way to fix it. */}
            {campaign.send_mode === "automatic" && floorStatus && !floorStatus.ready && (
              <Alert className="mt-3 border-amber-500/40 text-foreground [&>svg]:text-amber-600 dark:[&>svg]:text-amber-500">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="space-y-2">
                  <p className="text-xs">
                    These emails won't send automatically yet — your workspace still needs:
                  </p>
                  <ul className="ml-4 list-disc space-y-1 text-xs">
                    {floorStatus.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground">
                    Until then, each email waits in your Outreach list for you to send.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => navigate("/app/settings")}
                  >
                    <SettingsIcon className="mr-1.5 h-3.5 w-3.5" />
                    Open Settings
                  </Button>
                </AlertDescription>
              </Alert>
            )}
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
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">The messages</h2>
          {/* Edit the cadence — draft-only. Once people are enrolled the steps
              are locked (renumbering would break in-flight sends). */}
          {canEditSteps && !editingSteps && campaign.steps.length > 0 && (
            <Button variant="outline" size="sm" onClick={startEditingSteps}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit the steps
            </Button>
          )}
        </div>

        {editingSteps ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Add, remove, reorder or retime a touch. Removing a touch deletes its
              message; a new touch starts blank — you'll write it below. Your other
              messages move with their steps.
            </p>
            <CampaignScript
              steps={draftPlan}
              editable
              smsEnabled={smsEnabled}
              onChangeDelay={onChangeDelay}
              onRemove={onRemove}
              onMove={onMove}
              onChangeChannel={onChangeChannel}
              onInsert={onInsert}
              onToggleMeeting={onToggleMeeting}
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={cancelEditingSteps} disabled={savingSteps}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => setConfirmStepsSave(true)}
                disabled={savingSteps || draftPlan.length === 0}
              >
                {savingSteps ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save steps
              </Button>
            </div>
          </div>
        ) : campaign.steps.length === 0 ? (
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

      {/* Full-cadence generated script (Unit B Phase 2). Hidden while editing the
          steps (its copy is keyed by step_number — it would show stale rows until
          the reconciling save lands). Remounts via key after a save so it
          re-fetches the reconciled copy. */}
      {campaign.steps.length > 0 && !editingSteps && (
        <CampaignContentReview
          key={`content-${stepsRev}`}
          campaign={campaign}
          people={people}
          collateral={collateral}
        />
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
        onAdded={() => { loadPeople(); refreshCadenceGate(); }}
      />

      <AlertDialog open={confirmStepsSave} onOpenChange={setConfirmStepsSave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save these step changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your messages move with their steps. Any touch you removed will lose
              its written message, and any new touch starts blank for you to write.
              Nothing is sent — this just reshapes the plan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={doSaveSteps}>Save steps</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
