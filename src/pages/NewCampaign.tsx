import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Mail,
  PhoneCall,
  Phone,
  Paperclip,
  Loader2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { CanonicalChannel } from "@/lib/channels";
import {
  DEFAULT_GLOBAL_INSTRUCTIONS,
  buildDefaultPlan,
  insertStep,
  removeStep,
  moveStep,
  changeStepChannel,
  setStepGap,
  setStepMeetingCta,
  type DraftStep,
} from "@/lib/campaignDefaults";
import {
  createCampaignWithSteps,
  deleteCampaign,
  type CampaignType,
} from "@/lib/campaignQueries";
import { enrollLeadsInCampaign } from "@/lib/campaignEnrollment";
import { ingestCampaignKnowledge } from "@/lib/generateCampaignContent";
import {
  starterToCreateInput,
  type StarterCadence,
} from "@/lib/starterCadences";
import { CampaignScript } from "@/components/automations/CampaignScript";
import { StarterCadencePicker } from "@/components/automations/StarterCadencePicker";
import { getLeadsList, type LeadListItem } from "@/lib/supabaseQueries";
import { Checkbox } from "@/components/ui/checkbox";

type Step = 1 | 2 | 3;

interface OptionalChannel {
  channel: CanonicalChannel;
  label: string;
  icon: typeof Mail;
}

const OPTIONAL_CHANNELS: OptionalChannel[] = [
  { channel: "voice", label: "Calls", icon: PhoneCall },
  { channel: "sms", label: "Texts", icon: Phone },
];

// Client-side filter over the already-loaded lead list — no new query. Matches
// the typed text against name, company, and email (case-insensitive, trimmed).
// An empty/whitespace query returns the list unchanged.
export function filterLeads(leads: LeadListItem[], query: string): LeadListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return leads;
  return leads.filter((l) =>
    [l.name, l.company, l.email].some((field) =>
      (field ?? "").toLowerCase().includes(q),
    ),
  );
}

export default function NewCampaign() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();

  const [step, setStep] = useState<Step>(1);

  // Step 1 — basics
  const [name, setName] = useState("");
  const [campaignType, setCampaignType] = useState<CampaignType>("general");
  const [channels, setChannels] = useState<Set<CanonicalChannel>>(new Set(["email"]));
  const [offer, setOffer] = useState("");
  // Keep the actual File so we can read its text and ingest it as campaign
  // knowledge on save — not just its name. Optional; never blocks saving.
  const [file, setFile] = useState<File | null>(null);
  const [instructions, setInstructions] = useState(DEFAULT_GLOBAL_INSTRUCTIONS);
  const [editOpen, setEditOpen] = useState(false);

  // Workspace channel availability. Only SMS needs workspace setup (a Twilio
  // number). Calls go out from the rep's own phone, so they're always
  // available; email is the core channel and always on.
  const [smsEnabled, setSmsEnabled] = useState(false);

  // Step 2 — plan
  const [plan, setPlan] = useState<DraftStep[]>([]);

  // Step 3 — recipients
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
  const [leadSearch, setLeadSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // Which starter cadence (if any) is currently being cloned into a draft.
  const [startingId, setStartingId] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    supabase
      .from("workspaces")
      .select("sms_enabled")
      .eq("id", workspaceId)
      .single()
      .then(({ data }) => {
        setSmsEnabled(data?.sms_enabled ?? false);
      });
  }, [workspaceId]);

  const channelAvailable = (ch: CanonicalChannel) =>
    ch === "sms" ? smsEnabled : true;

  const toggleChannel = (ch: CanonicalChannel) => {
    if (!channelAvailable(ch)) return;
    const next = new Set(channels);
    next.has(ch) ? next.delete(ch) : next.add(ch);
    next.add("email"); // email always stays on
    setChannels(next);
  };

  const composedInstructions = useMemo(() => {
    const offerLine = offer.trim() ? `What we're offering: ${offer.trim()}\n\n` : "";
    return offerLine + instructions.trim();
  }, [offer, instructions]);

  // Clone a ready-made cadence into a new DRAFT outreach and open it for
  // editing. Reuses the exact same createCampaignWithSteps path as the custom
  // builder — the draft inherits send_mode 'review' (manual); the SMS touch is
  // kept regardless of sms_enabled (the picker flags when it needs enabling).
  const handleUseStarter = async (cadence: StarterCadence) => {
    if (!workspaceId) {
      toast.error("No workspace selected.");
      return;
    }
    setStartingId(cadence.id);
    try {
      const campaignId = await createCampaignWithSteps(
        starterToCreateInput(cadence, workspaceId),
      );
      toast.success(`"${cadence.name}" added as a draft — edit it before anything sends.`);
      navigate(`/app/automations/${campaignId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that cadence");
      setStartingId(null);
    }
  };

  const handleBuild = () => {
    if (!name.trim()) {
      toast.error("Give your outreach a name first.");
      return;
    }
    setPlan(buildDefaultPlan(Array.from(channels)));
    setStep(2);
  };

  // All structural edits go through the pure plan helpers, which renumber, keep
  // the first touch on day 0, recompute the gap chain so the schedule stays what
  // the rep intended, and keep each email's intent coherent with its position.
  const handleChangeDelay = (index: number, delayDays: number) => {
    setPlan((prev) => setStepGap(prev, index, delayDays));
  };

  const handleRemove = (index: number) => {
    setPlan((prev) => removeStep(prev, index));
  };

  const handleMove = (index: number, dir: -1 | 1) => {
    setPlan((prev) => moveStep(prev, index, dir));
  };

  const handleChangeChannel = (index: number, channel: CanonicalChannel) => {
    setPlan((prev) => changeStepChannel(prev, index, channel));
  };

  const handleInsert = (atIndex: number, channel: CanonicalChannel) => {
    setPlan((prev) => insertStep(prev, atIndex, channel));
  };

  const handleToggleMeeting = (index: number, value: boolean) => {
    setPlan((prev) => setStepMeetingCta(prev, index, value));
  };

  const goToRecipients = () => {
    if (plan.length === 0) {
      toast.error("Keep at least one message in your outreach.");
      return;
    }
    setStep(3);
    if (leads.length === 0) {
      setLeadsLoading(true);
      getLeadsList()
        .then(setLeads)
        .catch(() => toast.error("Couldn't load your people"))
        .finally(() => setLeadsLoading(false));
    }
  };

  const toggleLead = (id: string) => {
    const next = new Set(selectedLeads);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedLeads(next);
  };

  // The list the rep is actually looking at after typing in the search box.
  const visibleLeads = useMemo(
    () => filterLeads(leads, leadSearch),
    [leads, leadSearch],
  );

  // "Select all" is in the cleared state until every VISIBLE lead is selected.
  const allVisibleSelected =
    visibleLeads.length > 0 && visibleLeads.every((l) => selectedLeads.has(l.id));

  // Only ever touches what's on screen — selecting adds the visible leads,
  // clearing removes only them, leaving any off-screen selections intact.
  const toggleSelectAllVisible = () => {
    const next = new Set(selectedLeads);
    if (allVisibleSelected) {
      visibleLeads.forEach((l) => next.delete(l.id));
    } else {
      visibleLeads.forEach((l) => next.add(l.id));
    }
    setSelectedLeads(next);
  };

  const summary = useMemo(() => {
    const emailCount = plan.filter((s) => s.channel === "email").length;
    const callCount = plan.filter((s) => s.channel === "voice").length;
    const textCount = plan.filter((s) => s.channel === "sms").length;
    const parts = [
      `${plan.length} message${plan.length === 1 ? "" : "s"}`,
    ];
    const mix: string[] = [];
    if (emailCount) mix.push(`${emailCount} email${emailCount === 1 ? "" : "s"}`);
    if (callCount) mix.push(`${callCount} call${callCount === 1 ? "" : "s"}`);
    if (textCount) mix.push(`${textCount} text${textCount === 1 ? "" : "s"}`);
    const who =
      selectedLeads.size > 0
        ? `to ${selectedLeads.size} ${selectedLeads.size === 1 ? "person" : "people"}`
        : "and you'll add people next";
    return `${parts[0]} (${mix.join(", ")}) ${who}, spaced out automatically. Saved as a draft — nothing sends yet.`;
  }, [plan, selectedLeads]);

  const handleConfirm = async () => {
    if (!workspaceId) {
      toast.error("No workspace selected.");
      return;
    }
    setSaving(true);
    try {
      const defaultChannel: CanonicalChannel = "email";
      const campaignId = await createCampaignWithSteps({
        workspace_id: workspaceId,
        name: name.trim(),
        campaign_type: campaignType,
        default_channel: defaultChannel,
        include_meeting_cta: false,
        global_instructions: composedInstructions,
        // The flyer (if any) is ingested below via ingestCampaignKnowledge,
        // which sets knowledge_ref + knowledge_document_id only on success.
        // Leave it null here so a file we couldn't read never shows as attached.
        knowledge_ref: null,
        steps: plan.map((s, i) => ({
          step_number: s.step_number,
          step_type: s.step_type,
          channel: s.channel,
          // First touch always goes out right away (day 0); guard regardless
          // of any edits made in the review step.
          delay_days: i === 0 ? 0 : s.delay_days,
          cta_type: s.cta_type,
          custom_instructions: s.custom_instructions,
          active: s.active,
          variant_group: null,
          // Per-step meeting-link choice (email touches); null = inherit default.
          include_meeting_cta: s.include_meeting_cta ?? null,
        })),
      });

      // Per-reason skip lines, mirroring the add-people dialog. enrollLeadsInCampaign
      // skips leads for several distinct safety reasons (opted out, do-not-contact,
      // already in another outreach, no email) — report the ACTUAL reason so the rep
      // gets the right remediation, not a blanket "already in another outreach".
      const skipLines: string[] = [];
      if (selectedLeads.size > 0) {
        // Route creation-time recipients through the SAME enrollment path as the
        // add-people dialog, so they get campaign_enrollment + campaign_touch rows
        // (the scheduler/queue source of truth) — not just a campaign_id stamp.
        // If enrollment throws, the campaign + steps were already created — roll them
        // back so a failed create doesn't leave an orphaned outreach behind (deleting
        // the campaign cascades to its steps and any partial enrollment/touch rows).
        try {
          const result = await enrollLeadsInCampaign(campaignId, Array.from(selectedLeads));
          const s = result.skips;
          if (s.unsubscribed) skipLines.push(`${s.unsubscribed} opted out — won't be contacted`);
          if (s.suppressed) skipLines.push(`${s.suppressed} on your do-not-contact list`);
          if (s.alreadyEnrolled) skipLines.push(`${s.alreadyEnrolled} already in another outreach`);
          if (s.missingEmail) skipLines.push(`${s.missingEmail} have no email address`);
          if (s.activeOrCustomer) skipLines.push(`${s.activeOrCustomer} skipped — already a customer or closed deal, have a meeting booked, or recently replied`);
        } catch (enrollErr) {
          await deleteCampaign(campaignId).catch(() => {
            /* best-effort cleanup; surface the ORIGINAL enrollment error below */
          });
          throw enrollErr;
        }
      }

      // Flyer ingest — best-effort, AFTER the campaign exists. Uses the SAME
      // text-extraction + ingest path as the campaign page's "Add knowledge
      // file" button (CampaignContentReview.handleUpload). The flyer is
      // optional: if it can't be read (e.g. a scanned/image-only PDF, which
      // ingestCampaignKnowledge rejects with a friendly message), we save the
      // outreach anyway and just flag it — it must never roll back or block.
      let flyerFailed = false;
      if (file) {
        try {
          const text = await file.text();
          await ingestCampaignKnowledge(campaignId, text, file.name);
        } catch {
          flyerFailed = true;
        }
      }

      toast.success("Outreach saved as a draft");
      if (flyerFailed) {
        toast.info("Saved — but we couldn't read that file. Add a text-based one on the next page.");
      }
      if (skipLines.length > 0) {
        toast.info(`Some people weren't added — ${skipLines.join("; ")}.`);
      }
      navigate(`/app/automations/${campaignId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save your outreach");
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-12">
      {/* Header / progress */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => (step === 1 ? navigate("/app/automations") : setStep((step - 1) as Step))}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">New outreach</h1>
          <p className="text-sm text-muted-foreground">Step {step} of 3</p>
        </div>
      </div>

      {/* ── Step 1: basics ── */}
      {step === 1 && (
        <div className="space-y-6">
          {/* Ready-made cadences — one click clones into an editable draft. */}
          <StarterCadencePicker
            smsEnabled={smsEnabled}
            startingId={startingId}
            onUse={handleUseStarter}
            disabled={saving}
          />

          <div className="flex items-center gap-3" role="separator">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              or build your own
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">What's this outreach called?</Label>
            <Input
              id="name"
              placeholder="e.g. End-of-year offer"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Who is it for?</Label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setCampaignType("general")}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  campaignType === "general"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent"
                }`}
              >
                <span className="text-sm font-medium text-foreground">Everyone</span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  One set of messages for all your people.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setCampaignType("industry")}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  campaignType === "industry"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent"
                }`}
              >
                <span className="text-sm font-medium text-foreground">By industry</span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Tailored messages per industry. You'll set this up on the next page after saving.
                </p>
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>How do you want to reach them?</Label>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-primary/5 px-3 py-1.5 text-sm font-medium text-foreground">
                <Mail className="h-3.5 w-3.5" />
                Email
              </span>
              {OPTIONAL_CHANNELS.map(({ channel, label, icon: Icon }) => {
                const available = channelAvailable(channel);
                const on = channels.has(channel);
                return (
                  <div key={channel} className="flex flex-col">
                    <button
                      type="button"
                      disabled={!available}
                      onClick={() => toggleChannel(channel)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                        !available
                          ? "cursor-not-allowed border-border text-muted-foreground opacity-60"
                          : on
                            ? "border-primary bg-primary/5 text-foreground"
                            : "border-border text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                    {!available && (
                      <span className="mt-1 max-w-[8rem] text-[11px] leading-tight text-muted-foreground">
                        Not set up yet — add it in Settings.
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Email is always on. Calls and texts go out from your own phone.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="offer">What are you offering?</Label>
            <Textarea
              id="offer"
              placeholder="A sentence or two about the deal, product, or reason you're reaching out."
              value={offer}
              onChange={(e) => setOffer(e.target.value)}
              rows={3}
              className="resize-none"
            />
          </div>

          <div className="space-y-2">
            <Label>Have a flyer or one-pager? (optional)</Label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent">
              <Paperclip className="h-4 w-4" />
              {file ? (
                <span className="text-foreground">{file.name}</span>
              ) : (
                <span>Attach a file — we'll use it to write your messages.</span>
              )}
              <input
                type="file"
                accept=".txt,.md,.csv,.text"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          {/* Edit instructions — tucked away so it never clutters the basics */}
          <Collapsible open={editOpen} onOpenChange={setEditOpen}>
            <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
              Edit instructions
              <ChevronDown
                className={`ml-auto h-3.5 w-3.5 transition-transform ${editOpen ? "rotate-180" : ""}`}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={6}
                className="resize-none text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                These guide how every message is written. Edit anytime.
              </p>
            </CollapsibleContent>
          </Collapsible>

          <Button className="w-full" size="lg" onClick={handleBuild}>
            Build my outreach
          </Button>
        </div>
      )}

      {/* ── Step 2: review the plan ── */}
      {step === 2 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Here's your outreach
            </h2>
            <p className="text-sm text-muted-foreground">
              Read it top to bottom. Nudge the spacing or drop a message if you want —
              you'll review and edit the actual wording after you save.
            </p>
          </div>

          <CampaignScript
            steps={plan}
            editable
            smsEnabled={smsEnabled}
            onChangeDelay={handleChangeDelay}
            onRemove={handleRemove}
            onMove={handleMove}
            onChangeChannel={handleChangeChannel}
            onInsert={handleInsert}
            onToggleMeeting={handleToggleMeeting}
          />

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button className="flex-1" onClick={goToRecipients}>
              Looks good
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 3: recipients + confirm ── */}
      {step === 3 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-base font-semibold text-foreground">Who's it going to?</h2>
            <p className="text-sm text-muted-foreground">
              Pick people now, or save the draft and add them later.
            </p>
          </div>

          {!leadsLoading && leads.length > 0 && (
            <div className="space-y-2">
              <Input
                placeholder="Search people"
                value={leadSearch}
                onChange={(e) => setLeadSearch(e.target.value)}
              />
              <div className="flex items-center justify-between px-1">
                <span className="text-xs text-muted-foreground">
                  {visibleLeads.length} {visibleLeads.length === 1 ? "person" : "people"}
                </span>
                <button
                  type="button"
                  onClick={toggleSelectAllVisible}
                  disabled={visibleLeads.length === 0}
                  className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                >
                  {allVisibleSelected ? "Clear" : "Select all"}
                </button>
              </div>
            </div>
          )}

          <Card>
            <CardContent className="max-h-72 overflow-y-auto p-2">
              {leadsLoading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : leads.length === 0 ? (
                <div className="flex flex-col items-center gap-1 py-10 text-center">
                  <Users className="h-5 w-5 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No people yet — you can add them after saving.
                  </p>
                </div>
              ) : visibleLeads.length === 0 ? (
                <div className="flex flex-col items-center gap-1 py-10 text-center">
                  <Users className="h-5 w-5 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No one matches "{leadSearch.trim()}".
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {visibleLeads.map((l) => (
                    <li key={l.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-2 py-2.5 hover:bg-accent">
                        <Checkbox
                          checked={selectedLeads.has(l.id)}
                          onCheckedChange={() => toggleLead(l.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {l.name}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {[l.company, l.email].filter(Boolean).join(" · ") || "—"}
                          </div>
                        </div>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <div className="rounded-lg bg-muted p-3">
            <p className="text-sm text-foreground">{summary}</p>
          </div>

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={() => setStep(2)} disabled={saving}>
              Back
            </Button>
            <Button className="flex-1" onClick={handleConfirm} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Save outreach
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
