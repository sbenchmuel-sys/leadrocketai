-- ═══════════════════════════════════════════════════════════════════
-- Unit 4 (PR 4.1) — sendable collateral: asset storage + hosted link.
--
-- Additive only. Adds a storage bucket + asset_* columns to the EXISTING
-- campaign_collateral table (the "same shelf" — uploaded briefs and the
-- existing AI text drafts coexist on one row per campaign×type×variant).
-- Sends NOTHING and inserts the link into NO email — that is PR 4.3, which
-- is the sender-touching, qa-mandatory PR. Applying this migration cannot
-- change a single outgoing email.
--
-- WHY A PUBLIC BUCKET. A brief linked in a COLD email must open for an
-- unauthenticated prospect in their browser, so the SERVED object is public
-- by URL (an unguessable UUID path = practical obscurity). Public-by-link is
-- inherent to "link in an email" — briefs must therefore not contain
-- workspace-confidential data. Privacy is enforced where it matters: only
-- workspace MEMBERS may upload/replace/delete, scoped by the first path
-- segment = workspace_id. Object path convention:
--   {workspace_id}/{campaign_id}/{collateral_id}/{filename}
--
-- The approval gate (draft → approved) is PR 4.2; this PR only lands the
-- raw upload + columns. An asset is NOT linkable to a sending touch until
-- 4.2 marks it approved.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Asset columns on campaign_collateral (uploaded brief) ─────────
ALTER TABLE public.campaign_collateral
  ADD COLUMN IF NOT EXISTS asset_path        text,   -- storage.objects path (private to upload)
  ADD COLUMN IF NOT EXISTS asset_url         text,   -- public first-party URL placed in the email (4.3)
  ADD COLUMN IF NOT EXISTS asset_mime        text,   -- application/pdf | image/png | image/jpeg
  ADD COLUMN IF NOT EXISTS asset_filename    text,   -- original name, for display only
  ADD COLUMN IF NOT EXISTS asset_size_bytes  bigint,
  ADD COLUMN IF NOT EXISTS asset_uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS asset_uploaded_at timestamptz;

COMMENT ON COLUMN public.campaign_collateral.asset_url IS
  'Public first-party URL of the uploaded brief. Inserted as a LINK (never an attachment) into the linked touch''s email body in PR 4.3. Only an APPROVED asset (PR 4.2) may be inserted.';

-- Only ever serve briefs we trust to render in a prospect's browser.
ALTER TABLE public.campaign_collateral
  DROP CONSTRAINT IF EXISTS campaign_collateral_asset_mime_check;
ALTER TABLE public.campaign_collateral
  ADD CONSTRAINT campaign_collateral_asset_mime_check
  CHECK (asset_mime IS NULL OR asset_mime IN ('application/pdf', 'image/png', 'image/jpeg'));

-- ── 2. Storage bucket for collateral briefs (PUBLIC read) ────────────
-- public=true so the emailed link opens without auth. Idempotent insert so
-- re-running the migration is safe (matches the codify-cron re-run promise).
INSERT INTO storage.buckets (id, name, public)
VALUES ('campaign-collateral', 'campaign-collateral', true)
ON CONFLICT (id) DO NOTHING;

-- DROP-then-CREATE each policy so re-applying this migration is safe (CREATE
-- POLICY has no IF NOT EXISTS). Policy names are bucket-specific, so this never
-- touches the call-recordings (or any other bucket's) policies.
DROP POLICY IF EXISTS "Service role can manage collateral storage" ON storage.objects;
DROP POLICY IF EXISTS "Members can read collateral storage"        ON storage.objects;
DROP POLICY IF EXISTS "Members can upload collateral storage"      ON storage.objects;
DROP POLICY IF EXISTS "Members can update collateral storage"      ON storage.objects;
DROP POLICY IF EXISTS "Members can delete collateral storage"      ON storage.objects;

-- service_role: full access (any future server-side processing).
CREATE POLICY "Service role can manage collateral storage"
  ON storage.objects FOR ALL
  USING (bucket_id = 'campaign-collateral')
  WITH CHECK (bucket_id = 'campaign-collateral');

-- Read: the bucket is public, so prospects fetch via the public object URL
-- without RLS. This SELECT policy lets authenticated members list/preview
-- their own workspace's objects in-app (scoped by the first path segment).
CREATE POLICY "Members can read collateral storage"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'campaign-collateral'
    AND public.is_workspace_member(((storage.foldername(name))[1])::uuid, auth.uid())
  );

-- Write (upload/replace/delete): workspace MEMBERS only, scoped so a member
-- can only write under their own workspace_id (the first path segment). This
-- is the real privacy boundary — public read does not imply public write.
CREATE POLICY "Members can upload collateral storage"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'campaign-collateral'
    AND public.is_workspace_member(((storage.foldername(name))[1])::uuid, auth.uid())
  );

CREATE POLICY "Members can update collateral storage"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'campaign-collateral'
    AND public.is_workspace_member(((storage.foldername(name))[1])::uuid, auth.uid())
  )
  WITH CHECK (
    bucket_id = 'campaign-collateral'
    AND public.is_workspace_member(((storage.foldername(name))[1])::uuid, auth.uid())
  );

CREATE POLICY "Members can delete collateral storage"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'campaign-collateral'
    AND public.is_workspace_member(((storage.foldername(name))[1])::uuid, auth.uid())
  );
