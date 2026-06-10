ALTER TABLE public.campaign_collateral
  ADD COLUMN IF NOT EXISTS asset_path        text,
  ADD COLUMN IF NOT EXISTS asset_url         text,
  ADD COLUMN IF NOT EXISTS asset_mime        text,
  ADD COLUMN IF NOT EXISTS asset_filename    text,
  ADD COLUMN IF NOT EXISTS asset_size_bytes  bigint,
  ADD COLUMN IF NOT EXISTS asset_uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS asset_uploaded_at timestamptz;

COMMENT ON COLUMN public.campaign_collateral.asset_url IS
  'Public first-party URL of the uploaded brief. Inserted as a LINK (never an attachment) into the linked touch''s email body in PR 4.3. Only an APPROVED asset (PR 4.2) may be inserted.';

ALTER TABLE public.campaign_collateral
  DROP CONSTRAINT IF EXISTS campaign_collateral_asset_mime_check;
ALTER TABLE public.campaign_collateral
  ADD CONSTRAINT campaign_collateral_asset_mime_check
  CHECK (asset_mime IS NULL OR asset_mime IN ('application/pdf', 'image/png', 'image/jpeg'));

DROP POLICY IF EXISTS "Service role can manage collateral storage" ON storage.objects;
DROP POLICY IF EXISTS "Members can read collateral storage"        ON storage.objects;
DROP POLICY IF EXISTS "Members can upload collateral storage"      ON storage.objects;
DROP POLICY IF EXISTS "Members can update collateral storage"      ON storage.objects;
DROP POLICY IF EXISTS "Members can delete collateral storage"      ON storage.objects;

CREATE POLICY "Service role can manage collateral storage"
  ON storage.objects FOR ALL
  TO service_role
  USING (bucket_id = 'campaign-collateral')
  WITH CHECK (bucket_id = 'campaign-collateral');

CREATE POLICY "Members can read collateral storage"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'campaign-collateral'
    AND public.is_workspace_member(((storage.foldername(name))[1])::uuid, auth.uid())
  );

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