// ============================================================================
// CAMPAIGN COLLATERAL SECTION (Outreach Unit D)
//
// AI-drafted, rep-editable collateral (one-pagers, technical walkthroughs) for a
// campaign, grounded in its instructions + knowledge document. Generate, edit
// inline, regenerate (confirm if edited), delete, and LINK a draft to an email
// touch.
//
// HONEST LABELLING: linking is a logical "shown to you when you send this email"
// association — NOT a send-time attachment (providers can't attach files yet;
// that's Unit C). The copy never says "attached" or implies the file is sent.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Loader2, Wand2, RefreshCw, Trash2, Check, FileText } from "lucide-react";
import { toast } from "sonner";
import { cumulativeDays } from "@/lib/campaignDefaults";
import {
  fetchCampaignCollateral,
  saveCollateralEdit,
  deleteCollateral,
  attachCollateralToStep,
  type CampaignWithSteps,
  type CampaignLead,
  type CampaignCollateral,
  type CollateralType,
} from "@/lib/campaignQueries";
import {
  generateCollateral,
  COLLATERAL_TYPES,
} from "@/lib/generateCampaignCollateral";
import {
  getIndustriesPresent,
  computePrimaryIndustry,
} from "@/lib/generateCampaignContent";

const GENERAL = "__general__";
const UNLINKED = "__none__";

interface Props {
  campaign: CampaignWithSteps;
  people: CampaignLead[];
}

export function CampaignCollateralSection({ campaign, people }: Props) {
  const isIndustry = campaign.campaign_type === "industry";
  const industries = useMemo(() => getIndustriesPresent(people), [people]);
  const primaryIndustry = useMemo(() => computePrimaryIndustry(people), [people]);

  const [variant, setVariant] = useState<string | null>(null);
  const variantChosen = useRef(false);
  const [rows, setRows] = useState<CampaignCollateral[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!variantChosen.current && isIndustry && primaryIndustry) setVariant(primaryIndustry);
  }, [isIndustry, primaryIndustry]);

  const chooseVariant = (v: string | null) => {
    variantChosen.current = true;
    setVariant(v);
  };

  const reload = useCallback(() => {
    setLoading(true);
    fetchCampaignCollateral(campaign.id)
      .then(setRows)
      .catch(() => toast.error("Couldn't load collateral"))
      .finally(() => setLoading(false));
  }, [campaign.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Email touches a collateral can be linked to ("Email · Day N").
  const emailTouches = useMemo(() => {
    const active = [...campaign.steps].filter((s) => s.active).sort((a, b) => a.step_number - b.step_number);
    const days = cumulativeDays(active);
    return active
      .map((s, i) => ({ stepNumber: s.step_number, day: days[i], channel: s.channel }))
      .filter((t) => t.channel === "email");
  }, [campaign.steps]);

  const variantKey = (v: string | null) => (v == null || v.trim() === "" ? "" : v);
  const rowFor = (type: CollateralType): CampaignCollateral | null =>
    rows.find((r) => r.collateral_type === type && variantKey(r.variant_group) === variantKey(variant)) ?? null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">Collateral</h2>
      <p className="text-xs text-muted-foreground">
        Shareable drafts built from your instructions and knowledge file. Review and edit them — they’re
        drafts you can send yourself, not auto-sent.
      </p>

      {isIndustry && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Showing:</span>
          <Select value={variant ?? GENERAL} onValueChange={(v) => chooseVariant(v === GENERAL ? null : v)}>
            <SelectTrigger className="h-8 w-auto min-w-[10rem] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {industries.map((ind) => (
                <SelectItem key={ind.industry} value={ind.industry}>
                  {ind.industry} ({ind.count}){ind.industry === primaryIndustry ? " · most common" : ""}
                </SelectItem>
              ))}
              <SelectItem value={GENERAL}>Everyone else (General)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading…</span>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {COLLATERAL_TYPES.map((t) => (
            <CollateralCard
              key={t.type}
              campaign={campaign}
              type={t.type}
              label={t.label}
              blurb={t.blurb}
              variant={variant}
              content={rowFor(t.type)}
              emailTouches={emailTouches}
              onChanged={reload}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface CardProps {
  campaign: CampaignWithSteps;
  type: CollateralType;
  label: string;
  blurb: string;
  variant: string | null;
  content: CampaignCollateral | null;
  emailTouches: { stepNumber: number; day: number }[];
  onChanged: () => void;
}

function CollateralCard({ campaign, type, label, blurb, variant, content, emailTouches, onChanged }: CardProps) {
  const [busy, setBusy] = useState<null | "gen" | "save" | "del">(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: content?.title ?? "", body: content?.body ?? "" });

  useEffect(() => {
    setDraft({ title: content?.title ?? "", body: content?.body ?? "" });
    setEditing(false);
  }, [content]);

  const edited = content?.is_edited === true;

  const generate = async () => {
    if (edited && !confirm("This replaces your edited version with a fresh draft. Continue?")) return;
    setBusy("gen");
    try {
      await generateCollateral(campaign, type, variant);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't generate");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      await saveCollateralEdit(campaign.id, type, variant, {
        title: draft.title || null,
        body: draft.body || null,
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

  const remove = async () => {
    if (!content) return;
    if (!confirm("Delete this collateral draft?")) return;
    setBusy("del");
    try {
      await deleteCollateral(content.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete");
    } finally {
      setBusy(null);
    }
  };

  const link = async (value: string) => {
    if (!content) return;
    try {
      await attachCollateralToStep(content.id, value === UNLINKED ? null : Number(value));
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't link");
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{label}</span>
          {edited && (
            <Badge variant="secondary" className="ml-1 gap-1 text-xs font-normal">
              <Check className="h-3 w-3" />
              edited by you
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            {content && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={generate}
                disabled={busy !== null}
                aria-label="Regenerate"
                title="Regenerate"
              >
                {busy === "gen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </Button>
            )}
            {content && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={remove}
                disabled={busy !== null}
                aria-label="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {!content ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">{blurb}</p>
            <Button size="sm" onClick={generate} disabled={busy !== null}>
              {busy === "gen" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
              Generate
            </Button>
          </div>
        ) : (
          <>
            {editing ? (
              <div className="space-y-2">
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  placeholder="Title"
                  className="text-sm font-medium"
                />
                <Textarea
                  value={draft.body}
                  onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                  rows={12}
                  className="resize-none text-sm"
                />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy === "save"}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={save} disabled={busy === "save"}>
                    {busy === "save" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {content.title && <p className="text-sm font-semibold text-foreground">{content.title}</p>}
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content.body}</p>
                <button
                  className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
              </div>
            )}

            {/* Honest link affordance — a logical association, NOT a send-time attachment. */}
            {emailTouches.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <span className="text-xs text-muted-foreground">Link to an email:</span>
                <Select
                  value={content.attached_step_number != null ? String(content.attached_step_number) : UNLINKED}
                  onValueChange={link}
                >
                  <SelectTrigger className="h-7 w-auto min-w-[9rem] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNLINKED}>Not linked</SelectItem>
                    {emailTouches.map((t) => (
                      <SelectItem key={t.stepNumber} value={String(t.stepNumber)}>
                        Email · Day {t.day}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                  (shown to you when you write that email — not auto-attached)
                </span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
