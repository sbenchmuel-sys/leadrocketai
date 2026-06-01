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
  type DraftStep,
} from "@/lib/campaignDefaults";
import {
  createCampaignWithSteps,
  addLeadsToCampaign,
  type CampaignType,
} from "@/lib/campaignQueries";
import { CampaignScript } from "@/components/automations/CampaignScript";
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

export default function NewCampaign() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();

  const [step, setStep] = useState<Step>(1);

  // Step 1 — basics
  const [name, setName] = useState("");
  const [campaignType, setCampaignType] = useState<CampaignType>("general");
  const [channels, setChannels] = useState<Set<CanonicalChannel>>(new Set(["email"]));
  const [offer, setOffer] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
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
  const [saving, setSaving] = useState(false);

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

  const handleBuild = () => {
    if (!name.trim()) {
      toast.error("Give your outreach a name first.");
      return;
    }
    setPlan(buildDefaultPlan(Array.from(channels)));
    setStep(2);
  };

  const handleChangeDelay = (index: number, delayDays: number) => {
    setPlan((prev) => prev.map((s, i) => (i === index ? { ...s, delay_days: delayDays } : s)));
  };

  const handleRemove = (index: number) => {
    setPlan((prev) =>
      prev
        .filter((_, i) => i !== index)
        .map((s, i) => ({ ...s, step_number: i + 1 })),
    );
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
        knowledge_ref: fileName,
        steps: plan.map((s) => ({
          step_number: s.step_number,
          step_type: s.step_type,
          channel: s.channel,
          delay_days: s.delay_days,
          cta_type: s.cta_type,
          custom_instructions: s.custom_instructions,
          active: s.active,
          variant_group: null,
        })),
      });

      if (selectedLeads.size > 0) {
        await addLeadsToCampaign(Array.from(selectedLeads), campaignId);
      }

      toast.success("Outreach saved as a draft");
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
                  Tailored messages per industry. We'll set this up next.
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
              {fileName ? (
                <span className="text-foreground">{fileName}</span>
              ) : (
                <span>Attach a file — we'll use it to write your messages.</span>
              )}
              <input
                type="file"
                className="hidden"
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
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
              the wording gets written in the next step.
            </p>
          </div>

          <CampaignScript
            steps={plan}
            editable
            onChangeDelay={handleChangeDelay}
            onRemove={handleRemove}
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
              ) : (
                <ul className="divide-y divide-border">
                  {leads.map((l) => (
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
