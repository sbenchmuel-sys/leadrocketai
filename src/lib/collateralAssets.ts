// ============================================================================
// Collateral assets — uploaded brief storage (Unit 4, PR 4.1)
//
// Uploads a DESIGNED one-pager (PDF/PNG/JPEG) to the workspace-scoped
// `campaign-collateral` bucket and records its public link on the existing
// campaign_collateral row (the "same shelf" as the AI text drafts).
//
// This module ONLY uploads + records. It does NOT insert the link into any
// email and does NOT mark the asset approved — those are PR 4.3 (sender) and
// PR 4.2 (approval gate). An uploaded-but-unapproved asset is inert.
//
// Path convention (the first segment is the privacy boundary enforced by the
// storage RLS policy): {workspace_id}/{campaign_id}/{collateral_id}/{filename}
// The bucket is public-read so the emailed link opens for an unauthenticated
// prospect; only workspace members may upload/replace/delete.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";

const BUCKET = "campaign-collateral";

// Mirror the DB CHECK constraint (campaign_collateral_asset_mime_check). Only
// formats that render safely in a prospect's browser.
export const ALLOWED_COLLATERAL_MIME = ["application/pdf", "image/png", "image/jpeg"] as const;
export type CollateralMime = (typeof ALLOWED_COLLATERAL_MIME)[number];

// Briefs are one-pagers; cap generously but bound it (deliverability + abuse).
export const MAX_COLLATERAL_BYTES = 10 * 1024 * 1024; // 10 MB

export interface UploadedCollateralAsset {
  assetPath: string;
  assetUrl: string;
  assetMime: CollateralMime;
  assetFilename: string;
  assetSizeBytes: number;
}

function isAllowedMime(mime: string): mime is CollateralMime {
  return (ALLOWED_COLLATERAL_MIME as readonly string[]).includes(mime);
}

// Keep only safe path characters; the storage path must stay predictable and
// must never let a crafted filename escape the workspace folder.
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_");
  return cleaned.replace(/^[._]+/, "").slice(0, 120) || "brief";
}

/**
 * Upload a designed brief and stamp its public link onto the campaign_collateral
 * row. Returns the recorded asset metadata. Throws (with a rep-readable message)
 * on a rejected file type, an oversize file, or a storage/db failure.
 *
 * `workspaceId` is the campaign's workspace — it forms the first path segment and
 * is what the storage RLS policy checks, so passing the wrong workspace fails the
 * upload rather than leaking across workspaces.
 */
export async function uploadCollateralAsset(params: {
  workspaceId: string;
  campaignId: string;
  collateralId: string;
  file: File;
}): Promise<UploadedCollateralAsset> {
  const { workspaceId, campaignId, collateralId, file } = params;

  if (!isAllowedMime(file.type)) {
    throw new Error("Upload a PDF, PNG, or JPEG brief.");
  }
  if (file.size > MAX_COLLATERAL_BYTES) {
    throw new Error("That file is too large — keep briefs under 10 MB.");
  }

  const filename = sanitizeFilename(file.name);
  const path = `${workspaceId}/${campaignId}/${collateralId}/${filename}`;

  // Read the target row FIRST. This (a) fails fast before we waste an upload if
  // the collateral slot is gone or RLS-hidden, and (b) gives us the previous
  // asset_path so we can clean up the old object after a successful replace.
  const { data: existing, error: readErr } = await supabase
    .from("campaign_collateral" as any)
    .select("asset_path")
    .eq("id", collateralId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message || "Couldn't load the campaign brief slot");
  if (!existing) throw new Error("That campaign brief slot no longer exists.");
  const previousPath = (existing as any).asset_path as string | null;

  const userId = (await supabase.auth.getUser()).data.user?.id ?? null;

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: true });
  if (uploadErr) throw new Error(uploadErr.message || "Couldn't upload the brief");

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const assetUrl = pub.publicUrl;

  // Record the link on the collateral row. New columns aren't in the generated
  // types yet (Lovable regenerates after the migration applies) → cast.
  // `.select().maybeSingle()` so a zero-row match (stale/deleted/RLS-hidden row)
  // is a HARD FAILURE — otherwise we'd return a public URL for a brief that was
  // never recorded (an orphaned, un-sendable upload reported as "saved").
  const { data: updated, error: updateErr } = await supabase
    .from("campaign_collateral" as any)
    .update({
      asset_path: path,
      asset_url: assetUrl,
      asset_mime: file.type,
      asset_filename: filename,
      asset_size_bytes: file.size,
      asset_uploaded_at: new Date().toISOString(),
      asset_uploaded_by: userId,
    } as any)
    .eq("id", collateralId)
    .select("id")
    .maybeSingle();
  if (updateErr || !updated) {
    // Best-effort cleanup so a failed record-write doesn't orphan the object.
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    throw new Error(updateErr?.message || "Uploaded the file but couldn't save it to the campaign");
  }

  // Replace cleanup: a new filename produces a new path, so the prior object is
  // now unreferenced. The bucket is public-read, so a lingering old object stays
  // reachable forever (and removeCollateralAsset can't reach it once the row's
  // asset_path is overwritten). Remove it, best-effort, only when it differs.
  if (previousPath && previousPath !== path) {
    await supabase.storage.from(BUCKET).remove([previousPath]).catch(() => {});
  }

  return {
    assetPath: path,
    assetUrl,
    assetMime: file.type,
    assetFilename: filename,
    assetSizeBytes: file.size,
  };
}

/**
 * Remove an uploaded brief: delete the object and clear the asset_* columns.
 * Leaves any AI text draft on the same row untouched.
 */
export async function removeCollateralAsset(collateralId: string, assetPath: string): Promise<void> {
  // Clear the row FIRST, scoped to id AND the asset_path the caller is looking
  // at. If another tab/user has already replaced the brief, asset_path no longer
  // matches → zero rows update → this is a STALE remove: no-op, and crucially we
  // do NOT delete storage (that object now belongs to the newer asset). Clearing
  // before deleting means we only ever remove an object we authoritatively own.
  const { data: cleared, error: updateErr } = await supabase
    .from("campaign_collateral" as any)
    .update({
      asset_path: null,
      asset_url: null,
      asset_mime: null,
      asset_filename: null,
      asset_size_bytes: null,
      asset_uploaded_at: null,
      asset_uploaded_by: null,
    } as any)
    .eq("id", collateralId)
    .eq("asset_path", assetPath)
    .select("id")
    .maybeSingle();
  if (updateErr) throw new Error(updateErr.message || "Couldn't clear the brief from the campaign");
  if (!cleared) return; // already changed elsewhere — leave the current asset alone

  // We authoritatively cleared the current asset → remove its object. Best-effort:
  // the row is the source of truth, so a lingering object is a harmless orphan, not
  // a dangling reference — don't fail the whole removal on a transient storage error.
  await supabase.storage.from(BUCKET).remove([assetPath]).catch(() => {});
}
