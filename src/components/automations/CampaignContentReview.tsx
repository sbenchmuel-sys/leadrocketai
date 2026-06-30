// ============================================================================
// CAMPAIGN CONTENT REVIEW (Outreach Unit B, Phase 2)
//
// The full-cadence script a rep reads top to bottom: every email (subject +
// body), call talking points, voicemail, and SMS — in order. Inline edit,
// per-touch Rewrite, a couple of options to pick from, an industry switcher
// (one industry at a time), an "edited by you" mark, and an ADVISORY spam
// heads-up with one-tap "soften". All generation routes through ai_task via the
// orchestrator in generateCampaignContent.ts.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  Upload,
  Wand2,
  AlertTriangle,
  Check,
  FileText,
  Calendar,
  PenLine,
} from "lucide-react";
import { toast } from "sonner";
import { touchVerb, cumulativeDays } from "@/lib/campaignDefaults";
import {
  fetchStepContent,
  saveStepEdit,
  selectStepOption,
  type CampaignWithSteps,
  type CampaignStep,
  type CampaignLead,
  type StepContent,
  type StepContentOption,
  type CampaignCollateral,
} from "@/lib/campaignQueries";
import { collateralLabel } from "@/lib/generateCampaignCollateral";
import {
  generateAllTouches,
  generateTouch,
  rewriteTouch,
  softenTouch,
  ingestCampaignKnowledge,
  contentKindForChannel,
  getIndustriesPresent,
  computePrimaryIndustry,
  checkSpamHeuristics,
  MAX_REASONABLE_INDUSTRIES,
  type GenerateAllProgress,
} from "@/lib/generateCampaignContent";
import { MergeFieldToolbar } from "@/components/automations/MergeFieldToolbar";
import { MergeFieldEditor, type MergeFieldEditorHandle } from "@/components/automations/MergeFieldEditor";

const GENERAL = "__general__"; // Select value for the null/General variant

interface Props {
  campaign: CampaignWithSteps;
  people: CampaignLead[];
  // Collateral rows (lifted to CampaignDetail) so a touch can show what's linked
  // to it. Read-only here — linking is managed in the Collateral section.
  collateral?: CampaignCollateral[];
}

export function CampaignContentReview({ campaign, people, collateral }: Props) {
  const isIndustry = campaign.campaign_type === "industry";
  const industries = useMemo(() => getIndustriesPresent(people), [people]);
  const primaryIndustry = useMemo(() => computePrimaryIndustry(people), [people]);

  // Which variant the rep is viewing (null = General / fallback).
  const [variant, setVariant] = useState<string | null>(null);
  const [rows, setRows] = useState<StepContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [genAll, setGenAll] = useState<GenerateAllProgress | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Authoring mode. `null` = not chosen yet (empty state shows both options).
  // `"manual"` = rep writes from scratch, with per-touch Generate-this-one help.
  // `"auto"` = AI builds everything (current default flow).
  const [mode, setMode] = useState<null | "manual" | "auto">(null);
  const [switchTo, setSwitchTo] = useState<null | "manual" | "auto">(null);
  // Whether the rep has explicitly chosen a variant. `null` is BOTH the initial
  // "not chosen" state AND the legitimate value for "Everyone else (General)",
  // so we track the choice separately rather than treating null as uninitialized.
  const variantChosen = useRef(false);

  // Default to the primary industry once people load (industry campaigns) — but
  // ONLY before the rep has picked, so choosing General (null) isn't overridden.
  useEffect(() => {
    if (!variantChosen.current && isIndustry && primaryIndustry) setVariant(primaryIndustry);
  }, [isIndustry, primaryIndustry]);

  const chooseVariant = (v: string | null) => {
    variantChosen.current = true;
    setVariant(v);
  };

  const reload = useCallback(() => {
    setLoading(true);
    fetchStepContent(campaign.id)
      .then(setRows)
      .catch(() => toast.error("Couldn't load the messages"))
      .finally(() => setLoading(false));
  }, [campaign.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const activeSteps = useMemo(
    () => [...campaign.steps].filter((s) => s.active).sort((a, b) => a.step_number - b.step_number),
    [campaign.steps],
  );
  const days = useMemo(() => cumulativeDays(activeSteps), [activeSteps]);

  const variantKey = (v: string | null) => (v == null || v.trim() === "" ? "" : v);
  const rowFor = (stepNumber: number): StepContent | null =>
    rows.find(
      (r) => r.step_number === stepNumber && variantKey(r.variant_group) === variantKey(variant),
    ) ?? null;

  const anyContentForVariant = activeSteps.some((s) => rowFor(s.step_number));

  const handleGenerateAll = async (force: boolean) => {
    setGenAll({ done: 0, total: activeSteps.length, step: activeSteps[0], skipped: false });
    try {
      const res = await generateAllTouches(campaign, variant, {
        force,
        onProgress: (p) => setGenAll(p),
      });
      await fetchStepContent(campaign.id).then(setRows);
      toast.success(
        res.skipped > 0
          ? `Wrote ${res.generated} message${res.generated === 1 ? "" : "s"} (kept ${res.skipped} already written)`
          : `Wrote ${res.generated} message${res.generated === 1 ? "" : "s"}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Generation failed — try again");
    } finally {
      setGenAll(null);
    }
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const text = await file.text();
      await ingestCampaignKnowledge(campaign.id, text, file.name);
      toast.success("Knowledge file attached — new messages will use it");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that file");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const busy = genAll !== null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">The full script</h2>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.csv,.text"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || busy}
            title={campaign.knowledge_ref ? `Current file: ${campaign.knowledge_ref}` : "No file yet"}
          >
            {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {campaign.knowledge_document_id ? "Replace file" : "Add knowledge file"}
          </Button>
        </div>
      </div>

      {/* Industry switcher — one industry at a time */}
      {isIndustry && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Showing:</span>
          <Select
            value={variant ?? GENERAL}
            onValueChange={(v) => chooseVariant(v === GENERAL ? null : v)}
          >
            <SelectTrigger className="h-8 w-auto min-w-[10rem] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {industries.map((ind) => (
                <SelectItem key={ind.industry} value={ind.industry}>
                  {ind.industry} ({ind.count})
                  {ind.industry === primaryIndustry ? " · most common" : ""}
                </SelectItem>
              ))}
              <SelectItem value={GENERAL}>Everyone else (General)</SelectItem>
            </SelectContent>
          </Select>
          {industries.length > MAX_REASONABLE_INDUSTRIES && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {industries.length} industries — consider grouping for fewer versions
            </span>
          )}
        </div>
      )}

      {/* Mode pill — once the rep has picked an authoring path. */}
      {mode && anyContentForVariant && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Authoring:</span>
          <Badge variant="secondary" className="gap-1 font-normal">
            {mode === "manual" ? <PenLine className="h-3 w-3" /> : <Wand2 className="h-3 w-3" />}
            {mode === "manual" ? "Write my own" : "AI builder"}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setSwitchTo(mode === "manual" ? "auto" : "manual")}
          >
            Switch to {mode === "manual" ? "AI builder" : "Write my own"}
          </Button>
        </div>
      )}

      {/* Generate / progress */}
      {busy ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Writing {genAll!.done} of {genAll!.total}…
            </span>
          </CardContent>
        </Card>
      ) : !anyContentForVariant && mode !== "manual" ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">
              {isIndustry && variant
                ? `No messages for ${variant} yet. Build them when you're ready — or write your own.`
                : "No messages yet. Build the whole script from your instructions and knowledge file — or write your own."}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                onClick={() => {
                  setMode("auto");
                  handleGenerateAll(false);
                }}
                disabled={loading}
              >
                <Wand2 className="mr-2 h-4 w-4" />
                {isIndustry && variant ? `Build for ${variant}` : "Build the messages"}
              </Button>
              <span className="text-xs text-muted-foreground">or</span>
              <Button variant="outline" onClick={() => setMode("manual")} disabled={loading}>
                <PenLine className="mr-2 h-4 w-4" />
                Write my own
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {mode !== "manual" && (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => handleGenerateAll(false)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Fill in the rest
              </Button>
            </div>
          )}
          <div className="space-y-3">
            {activeSteps.map((step, i) => (
              <TouchCard
                key={step.id}
                campaign={campaign}
                step={step}
                day={days[i]}
                variant={variant}
                content={rowFor(step.step_number)}
                manualMode={mode === "manual"}
                linkedCollateral={(collateral ?? []).filter(
                  (c) =>
                    c.attached_step_number === step.step_number &&
                    variantKey(c.variant_group) === variantKey(variant),
                )}
                onChanged={reload}
              />
            ))}
          </div>
        </>
      )}

      <AlertDialog open={switchTo !== null} onOpenChange={(o) => !o && setSwitchTo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {switchTo === "auto" ? "Replace your messages with AI-written ones?" : "Clear AI-written messages?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {switchTo === "auto"
                ? "Switching to the AI builder rewrites every touch for this variant. Your current wording will be replaced."
                : "Switching to Write my own clears the current messages for this variant so you can write them yourself."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const target = switchTo;
                setSwitchTo(null);
                if (!target) return;
                if (target === "auto") {
                  setMode("auto");
                  await handleGenerateAll(true);
                } else {
                  // Clear current variant's content by saving empty fields per step.
                  try {
                    for (const s of activeSteps) {
                      await saveStepEdit(campaign.id, s.step_number, variant, {
                        subject: null,
                        body: null,
                        talking_points: null,
                        voicemail_script: null,
                        sms_text: null,
                      });
                    }
                    setMode("manual");
                    reload();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Couldn't clear");
                  }
                }
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// ── One touch ────────────────────────────────────────────────────────────────
interface TouchCardProps {
  campaign: CampaignWithSteps;
  step: CampaignStep;
  day: number;
  variant: string | null;
  content: StepContent | null;
  /** Manual-mode rep is writing from scratch — start empty rows in edit mode
   *  and show the merge-field toolbar plus per-touch "Generate this one". */
  manualMode?: boolean;
  linkedCollateral?: CampaignCollateral[];
  onChanged: () => void;
}

function TouchCard({ campaign, step, day, variant, content, manualMode, linkedCollateral, onChanged }: TouchCardProps) {
  const kind = contentKindForChannel(step.channel);
  const [busy, setBusy] = useState<null | "rewrite" | "soften" | "save" | "generate">(null);
  const emptyContent = !content || (!content.body && !content.subject && !content.talking_points && !content.sms_text);
  const [editing, setEditing] = useState(!!manualMode && emptyContent);

  // Refs for each editable field so the toolbar can insert tokens at the caret.
  const subjectRef = useRef<MergeFieldEditorHandle>(null);
  const bodyRef = useRef<MergeFieldEditorHandle>(null);
  const talkingRef = useRef<MergeFieldEditorHandle>(null);
  const voicemailRef = useRef<MergeFieldEditorHandle>(null);
  const smsRef = useRef<MergeFieldEditorHandle>(null);
  // Track which field was focused last so chip clicks hit the right one.
  const activeRef = useRef<"subject" | "body" | "talking" | "voicemail" | "sms">(
    kind === "email" ? "body" : kind === "voice" ? "talking" : kind === "sms" ? "sms" : "body",
  );

  // Local draft for inline edits.
  const [draft, setDraft] = useState({
    subject: content?.subject ?? "",
    body: content?.body ?? "",
    talking_points: content?.talking_points ?? "",
    voicemail_script: content?.voicemail_script ?? "",
    sms_text: content?.sms_text ?? "",
  });

  useEffect(() => {
    setDraft({
      subject: content?.subject ?? "",
      body: content?.body ?? "",
      talking_points: content?.talking_points ?? "",
      voicemail_script: content?.voicemail_script ?? "",
      sms_text: content?.sms_text ?? "",
    });
    setEditing(!!manualMode && (!content || (!content.body && !content.subject && !content.talking_points && !content.sms_text)));
  }, [content, manualMode]);

  const insertToken = (token: string) => {
    const ref =
      activeRef.current === "subject" ? subjectRef.current
      : activeRef.current === "body" ? bodyRef.current
      : activeRef.current === "talking" ? talkingRef.current
      : activeRef.current === "voicemail" ? voicemailRef.current
      : smsRef.current;
    ref?.insert(token);
  };

  const generateOne = async () => {
    setBusy("generate");
    try {
      await generateTouch(campaign, step, variant, { force: true });
      toast.success("Generated");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't generate");
    } finally {
      setBusy(null);
    }
  };


  const options = Array.isArray(content?.options_json) ? content!.options_json : [];
  const selected = content?.selected_option ?? 0;
  const edited = content?.is_edited === true;

  const spam =
    kind === "email" ? checkSpamHeuristics(draft.subject || content?.subject || null, draft.body || content?.body || null) : null;

  const save = async () => {
    setBusy("save");
    try {
      await saveStepEdit(campaign.id, step.step_number, variant, {
        subject: draft.subject || null,
        body: draft.body || null,
        talking_points: draft.talking_points || null,
        voicemail_script: draft.voicemail_script || null,
        sms_text: draft.sms_text || null,
      });
      toast.success("Saved your edit");
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  };

  const rewrite = async () => {
    if (edited && !confirm("This replaces your edited version with a fresh one. Continue?")) return;
    setBusy("rewrite");
    try {
      await rewriteTouch(campaign, step, variant);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rewrite");
    } finally {
      setBusy(null);
    }
  };

  const soften = async () => {
    if (!content) return;
    // Soften regenerates fresh AI copy rather than rephrasing the rep's exact
    // words, so on an edited row it would discard their wording. Same edit-lock
    // as the option picker / Rewrite: make the replacement explicit.
    if (edited && !confirm("This replaces your edited version with a softer AI version. Continue?")) return;
    setBusy("soften");
    try {
      await softenTouch(campaign, step, variant, content);
      toast.success("Softened the wording");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't soften");
    } finally {
      setBusy(null);
    }
  };

  const pick = async (idx: number, opt: StepContentOption) => {
    try {
      const applied = await selectStepOption(campaign.id, step.step_number, variant, idx, opt);
      if (!applied) toast.info("This message was edited — keeping your version");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't switch option");
    }
  };

  const hasContent = !!content && (content.body || content.talking_points || content.sms_text || content.subject);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        {/* Header row */}
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs font-normal">
            Day {day}
          </Badge>
          <span className="text-sm font-medium text-foreground">{touchVerb(step.channel)}</span>
          {step.channel === "email" && step.include_meeting_cta === true && (
            <Badge
              variant="secondary"
              className="ml-1 gap-1 text-xs font-normal"
              title="Your booking link is added to this email when it sends"
            >
              <Calendar className="h-3 w-3" />
              meeting link
            </Badge>
          )}
          {edited && (
            <Badge variant="secondary" className="ml-1 gap-1 text-xs font-normal">
              <Check className="h-3 w-3" />
              edited by you
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            {hasContent && !editing && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(true)} aria-label="Edit">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {hasContent && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={rewrite}
                disabled={busy !== null}
                aria-label="Rewrite"
                title="Rewrite this touch"
              >
                {busy === "rewrite" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Linked collateral — a draft to share yourself; NOT auto-attached/sent. */}
        {linkedCollateral && linkedCollateral.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {linkedCollateral.map((c) => (
              <Badge key={c.id} variant="outline" className="gap-1 text-xs font-normal">
                <FileText className="h-3 w-3" />
                {c.title || collateralLabel(c.collateral_type)}
              </Badge>
            ))}
            <span className="text-xs text-muted-foreground">linked — share it yourself when you send</span>
          </div>
        )}

        {!hasContent && !editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">
              {manualMode ? "Empty — write it below." : "Not written yet — use “Fill in the rest”."}
            </p>
            {manualMode && (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  Write it
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={generateOne}
                  disabled={busy !== null}
                >
                  {busy === "generate" ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Generate this one
                </Button>
              </>
            )}
          </div>
        ) : (
          <>
            {/* Option picker — hidden once the rep has edited (picking must never wipe edits) */}
            {!edited && options.length > 1 && !editing && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Options:</span>
                {options.map((opt, idx) => (
                  <Button
                    key={idx}
                    variant={idx === selected ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => pick(idx, opt)}
                  >
                    {idx + 1}
                  </Button>
                ))}
              </div>
            )}

            {/* Merge-field toolbar — visible whenever the rep is editing. */}
            {editing && <MergeFieldToolbar channel={step.channel} onInsert={insertToken} />}

            {/* Channel-shaped content */}
            {kind === "email" && (
              <div className="space-y-2">
                {editing ? (
                  <>
                    <div onFocus={() => (activeRef.current = "subject")}>
                      <MergeFieldEditor
                        ref={subjectRef}
                        asInput
                        channel={step.channel}
                        value={draft.subject}
                        onChange={(v) => setDraft((d) => ({ ...d, subject: v }))}
                        placeholder="Subject"
                        className="text-sm font-medium"
                      />
                    </div>
                    <div onFocus={() => (activeRef.current = "body")}>
                      <MergeFieldEditor
                        ref={bodyRef}
                        channel={step.channel}
                        value={draft.body}
                        onChange={(v) => setDraft((d) => ({ ...d, body: v }))}
                        rows={7}
                        className="resize-none text-sm"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    {content?.subject && (
                      <p className="text-sm font-semibold text-foreground">{content.subject}</p>
                    )}
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content?.body}</p>
                  </>
                )}
              </div>
            )}

            {kind === "voice" && (
              <div className="space-y-3">
                <Field label="Talking points">
                  {editing ? (
                    <div onFocus={() => (activeRef.current = "talking")}>
                      <MergeFieldEditor
                        ref={talkingRef}
                        channel={step.channel}
                        value={draft.talking_points}
                        onChange={(v) => setDraft((d) => ({ ...d, talking_points: v }))}
                        rows={4}
                        className="resize-none text-sm"
                      />
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content?.talking_points}</p>
                  )}
                </Field>
                <Field label="Voicemail (if no answer)">
                  {editing ? (
                    <div onFocus={() => (activeRef.current = "voicemail")}>
                      <MergeFieldEditor
                        ref={voicemailRef}
                        channel={step.channel}
                        value={draft.voicemail_script}
                        onChange={(v) => setDraft((d) => ({ ...d, voicemail_script: v }))}
                        rows={3}
                        className="resize-none text-sm"
                      />
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content?.voicemail_script}</p>
                  )}
                </Field>
              </div>
            )}

            {kind === "sms" && (
              <div>
                {editing ? (
                  <div onFocus={() => (activeRef.current = "sms")}>
                    <MergeFieldEditor
                      ref={smsRef}
                      channel={step.channel}
                      value={draft.sms_text}
                      onChange={(v) => setDraft((d) => ({ ...d, sms_text: v }))}
                      rows={2}
                      className="resize-none text-sm"
                    />
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content?.sms_text}</p>
                )}
              </div>
            )}

            {kind === "other" && (
              <div>
                {editing ? (
                  <div onFocus={() => (activeRef.current = "body")}>
                    <MergeFieldEditor
                      ref={bodyRef}
                      channel={step.channel}
                      value={draft.body}
                      onChange={(v) => setDraft((d) => ({ ...d, body: v }))}
                      rows={4}
                      placeholder={
                        step.channel === "linkedin"
                          ? "Write your LinkedIn message (kept short — connect notes are limited to ~300 characters)"
                          : "Write the message"
                      }
                      className="resize-none text-sm"
                    />
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content?.body}</p>
                )}
              </div>
            )}

            {/* Advisory spam heads-up (email only) — never blocks */}
            {spam && spam.level === "heads_up" && !editing && (
              <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="flex-1">
                  <span>This might trip spam filters: {spam.reasons.join(", ").toLowerCase()}.</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-amber-800 hover:text-amber-900"
                  onClick={soften}
                  disabled={busy !== null}
                >
                  {busy === "soften" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                  Soften
                </Button>
              </div>
            )}

            {/* Edit footer */}
            {editing && (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy === "save"}>
                  Cancel
                </Button>
                <Button size="sm" onClick={save} disabled={busy === "save"}>
                  {busy === "save" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
