// ============================================================================
// CAMPAIGN COLLATERAL SECTION (upload-first)
//
// Reps upload the real, designed one-pager they already have — one per industry
// on an industry campaign. The file is stored on the workspace-scoped
// `campaign-collateral` bucket (a hosted LINK, never an attachment) and offered
// in follow-up emails ONLY after the rep ticks "Use in this campaign's emails"
// (asset_ready) — that gating + the email wiring is a separate, sender-touching PR.
//
// AI generation of collateral was removed from this screen (the drafts weren't
// professional enough to send); the underlying generator stays in the codebase.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Upload, FileText, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  ensureCollateralRow,
  setCollateralAssetReady,
  type CampaignWithSteps,
  type CampaignLead,
  type CampaignCollateral,
} from "@/lib/campaignQueries";
import {
  uploadCollateralAsset,
  removeCollateralAsset,
  ALLOWED_COLLATERAL_MIME,
} from "@/lib/collateralAssets";
import {
  getIndustriesPresent,
  computePrimaryIndustry,
} from "@/lib/generateCampaignContent";

const GENERAL = "__general__";
const ACCEPT = ALLOWED_COLLATERAL_MIME.join(",");

interface Props {
  campaign: CampaignWithSteps;
  people: CampaignLead[];
  // Collateral rows + a refetch trigger are owned by CampaignDetail so this
  // section stays in sync with the rest of the page.
  collateral: CampaignCollateral[];
  onChanged: () => void;
}

const variantKey = (v: string | null) => (v == null || v.trim() === "" ? "" : v);

export function CampaignCollateralSection({ campaign, people, collateral, onChanged }: Props) {
  const isIndustry = campaign.campaign_type === "industry";
  const industries = useMemo(() => getIndustriesPresent(people), [people]);
  const primaryIndustry = useMemo(() => computePrimaryIndustry(people), [people]);

  const [variant, setVariant] = useState<string | null>(null);
  const variantChosen = useRef(false);
  const [busy, setBusy] = useState<null | "upload" | "remove">(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!variantChosen.current && isIndustry && primaryIndustry) setVariant(primaryIndustry);
  }, [isIndustry, primaryIndustry]);

  const chooseVariant = (v: string | null) => {
    variantChosen.current = true;
    setVariant(v);
  };

  // The one-pager row for a given variant (the only collateral type on this screen).
  const onePagerFor = (v: string | null): CampaignCollateral | null =>
    collateral.find(
      (r) => r.collateral_type === "one_pager" && variantKey(r.variant_group) === variantKey(v),
    ) ?? null;
  const hasUpload = (v: string | null) => !!onePagerFor(v)?.asset_path;

  const row = onePagerFor(variant);
  const uploaded = !!row?.asset_path;

  // Coverage across the industry slots (General is a fallback, not counted here).
  const coverage = useMemo(() => {
    const total = industries.length;
    const done = industries.filter((i) => hasUpload(i.industry)).length;
    return { total, done };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [industries, collateral]);

  const onPick = () => fileRef.current?.click();

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setBusy("upload");
    try {
      const id = row?.id ?? (await ensureCollateralRow(campaign.id, "one_pager", variant));
      await uploadCollateralAsset({
        workspaceId: campaign.workspace_id,
        campaignId: campaign.id,
        collateralId: id,
        file,
      });
      toast.success("One-pager uploaded");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't upload that file");
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async () => {
    if (!row?.asset_path) return;
    if (!confirm("Remove this one-pager? It won't be offered in any emails.")) return;
    setBusy("remove");
    try {
      await removeCollateralAsset(row.id, row.asset_path);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that file");
    } finally {
      setBusy(null);
    }
  };

  const onToggleReady = async (checked: boolean) => {
    if (!row) return;
    try {
      await setCollateralAssetReady(row.id, checked);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the brief");
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">One-pager</h2>
      <p className="text-xs text-muted-foreground">
        Upload the one-pager you want this campaign's follow-up emails to offer. Keep it free of
        anything confidential — the link opens publicly.
      </p>

      {isIndustry && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Showing:</span>
          <Select value={variant ?? GENERAL} onValueChange={(v) => chooseVariant(v === GENERAL ? null : v)}>
            <SelectTrigger className="h-8 w-auto min-w-[12rem] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {industries.map((ind) => (
                <SelectItem key={ind.industry} value={ind.industry}>
                  {ind.industry} ({ind.count}){hasUpload(ind.industry) ? " ✓" : " · needed"}
                </SelectItem>
              ))}
              <SelectItem value={GENERAL}>
                Everyone else (General){hasUpload(null) ? " ✓" : ""}
              </SelectItem>
            </SelectContent>
          </Select>
          {coverage.total > 0 && (
            <span className="text-xs text-muted-foreground">
              Uploaded for {coverage.done} of {coverage.total} industries
            </span>
          )}
        </div>
      )}

      <Card>
        <CardContent className="space-y-3 p-4">
          <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onFile} />

          {!uploaded ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">
                No one-pager yet{isIndustry && variant ? ` for ${variant}` : ""}.
              </p>
              <Button size="sm" onClick={onPick} disabled={busy !== null}>
                {busy === "upload" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Upload a one-pager
              </Button>
              <p className="text-xs text-muted-foreground">PDF, PNG or JPEG · up to 10MB</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium text-foreground">
                  {row?.asset_filename}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={onPick} disabled={busy !== null}>
                    {busy === "upload" ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Replace
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={onRemove}
                    disabled={busy !== null}
                  >
                    {busy === "remove" ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Remove
                  </Button>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border accent-primary"
                  checked={row?.asset_ready ?? false}
                  onChange={(e) => onToggleReady(e.target.checked)}
                />
                Use in this campaign's emails
              </label>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
