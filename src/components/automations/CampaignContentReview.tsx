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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  Upload,
  Wand2,
  AlertTriangle,
  Check,
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
} from "@/lib/campaignQueries";
import {
  generateAllTouches,
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

const GENERAL = "__general__"; // Select value for the null/General variant

interface Props {
  campaign: CampaignWithSteps;
  people: CampaignLead[];
}

export function CampaignContentReview({ campaign, people }: Props) {
  const isIndustry = campaign.campaign_type === "industry";
  const industries = useMemo(() => getIndustriesPresent(people), [people]);
  const primaryIndustry = useMemo(() => computePrimaryIndustry(people), [people]);

  // Which variant the rep is viewing (null = General / fallback).
  const [variant, setVariant] = useState<string | null>(isIndustry ? primaryIndustry : null);
  const [rows, setRows] = useState<StepContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [genAll, setGenAll] = useState<GenerateAllProgress | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Default to the primary industry once people load (industry campaigns).
  useEffect(() => {
    if (isIndustry && variant == null && primaryIndustry) setVariant(primaryIndustry);
  }, [isIndustry, primaryIndustry, variant]);

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
            onValueChange={(v) => setVariant(v === GENERAL ? null : v)}
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
      ) : !anyContentForVariant ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">
              {isIndustry && variant
                ? `No messages for ${variant} yet. Build them when you're ready.`
                : "No messages yet. Build the whole script from your instructions and knowledge file."}
            </p>
            <Button onClick={() => handleGenerateAll(false)} disabled={loading}>
              <Wand2 className="mr-2 h-4 w-4" />
              {isIndustry && variant ? `Build for ${variant}` : "Build the messages"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => handleGenerateAll(false)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Fill in the rest
            </Button>
          </div>
          <div className="space-y-3">
            {activeSteps.map((step, i) => (
              <TouchCard
                key={step.id}
                campaign={campaign}
                step={step}
                day={days[i]}
                variant={variant}
                content={rowFor(step.step_number)}
                onChanged={reload}
              />
            ))}
          </div>
        </>
      )}
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
  onChanged: () => void;
}

function TouchCard({ campaign, step, day, variant, content, onChanged }: TouchCardProps) {
  const kind = contentKindForChannel(step.channel);
  const [busy, setBusy] = useState<null | "rewrite" | "soften" | "save">(null);
  const [editing, setEditing] = useState(false);

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
    setEditing(false);
  }, [content]);

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

        {!hasContent ? (
          <p className="text-sm text-muted-foreground">Not written yet — use “Fill in the rest”.</p>
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

            {/* Channel-shaped content */}
            {kind === "email" && (
              <div className="space-y-2">
                {editing ? (
                  <>
                    <Input
                      value={draft.subject}
                      onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
                      placeholder="Subject"
                      className="text-sm font-medium"
                    />
                    <Textarea
                      value={draft.body}
                      onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                      rows={7}
                      className="resize-none text-sm"
                    />
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
                    <Textarea
                      value={draft.talking_points}
                      onChange={(e) => setDraft((d) => ({ ...d, talking_points: e.target.value }))}
                      rows={4}
                      className="resize-none text-sm"
                    />
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content?.talking_points}</p>
                  )}
                </Field>
                <Field label="Voicemail (if no answer)">
                  {editing ? (
                    <Textarea
                      value={draft.voicemail_script}
                      onChange={(e) => setDraft((d) => ({ ...d, voicemail_script: e.target.value }))}
                      rows={3}
                      className="resize-none text-sm"
                    />
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content?.voicemail_script}</p>
                  )}
                </Field>
              </div>
            )}

            {kind === "sms" && (
              <div>
                {editing ? (
                  <Textarea
                    value={draft.sms_text}
                    onChange={(e) => setDraft((d) => ({ ...d, sms_text: e.target.value }))}
                    rows={2}
                    className="resize-none text-sm"
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content?.sms_text}</p>
                )}
              </div>
            )}

            {kind === "other" && (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content?.body}</p>
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
