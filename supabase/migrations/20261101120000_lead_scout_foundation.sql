-- 20261101120000_lead_scout_foundation.sql
--
-- Lead Scout, Unit 1: data foundation (no UI, no cron).
-- DrivePilot finds new prospects weekly (Apollo search + email, Lusha phone).
-- Scout results land in the EXISTING review queue (lead_candidates +
-- PendingLeadsTab) as source = 'ai_scout'; nothing new is user-facing yet.
--
-- Re-runnable: IF NOT EXISTS / DROP ... IF EXISTS throughout.

-- ── 1. lead_candidates: accept scout rows ──────────────────────────────────

-- 1a. source CHECK. The original constraint was inline (auto-named
-- lead_candidates_source_check in 20260429180000 and its Lovable copy
-- 20260429075044). Drop whatever CHECK currently enumerates the sources, by
-- definition rather than by name, then re-add under a fixed name.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.lead_candidates'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%source%'
       AND pg_get_constraintdef(oid) ILIKE '%lookback_seed%'
  LOOP
    EXECUTE format('ALTER TABLE public.lead_candidates DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.lead_candidates
  ADD CONSTRAINT lead_candidates_source_check CHECK (source IN (
    'outbound', 'inbound_explicit', 'inbound_referral', 'lookback_seed', 'ai_scout'
  ));

-- 1b. Scout columns. All nullable; existing sources never set them.
ALTER TABLE public.lead_candidates
  ADD COLUMN IF NOT EXISTS job_title          TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_url       TEXT,
  ADD COLUMN IF NOT EXISTS company_name       TEXT,
  ADD COLUMN IF NOT EXISTS company_size       TEXT,
  ADD COLUMN IF NOT EXISTS location           TEXT,
  ADD COLUMN IF NOT EXISTS fit_label          TEXT CHECK (fit_label IS NULL OR fit_label IN ('high', 'good')),
  ADD COLUMN IF NOT EXISTS scout_batch_id     UUID,
  ADD COLUMN IF NOT EXISTS anchor_lead_id     UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider           TEXT,
  ADD COLUMN IF NOT EXISTS provider_person_id TEXT,
  ADD COLUMN IF NOT EXISTS dismiss_reason     TEXT;

-- 1c. contact_email: Apollo search returns no email before enrichment, so a
-- scout row may start without one. Every other source still requires it.
-- The lowercase trigger (20260514120000) already skips NULL.
-- idx_lead_candidates_unique_pending (workspace_id, contact_email) WHERE
-- status='pending' stays as is: NULLs are distinct in a Postgres unique
-- index, so many email-less pending scout rows coexist; scout rows are
-- deduped by provider_person_id below instead.
ALTER TABLE public.lead_candidates ALTER COLUMN contact_email DROP NOT NULL;
ALTER TABLE public.lead_candidates DROP CONSTRAINT IF EXISTS lead_candidates_contact_email_required_check;
ALTER TABLE public.lead_candidates
  ADD CONSTRAINT lead_candidates_contact_email_required_check
  CHECK (source = 'ai_scout' OR contact_email IS NOT NULL);

-- 1d. One scout row per provider person per workspace, ever (pending,
-- approved or dismissed) — a dismissed prospect is never re-suggested.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_candidates_scout_provider_person
  ON public.lead_candidates (workspace_id, provider, provider_person_id)
  WHERE source = 'ai_scout';

CREATE INDEX IF NOT EXISTS idx_lead_candidates_scout_batch
  ON public.lead_candidates (scout_batch_id)
  WHERE scout_batch_id IS NOT NULL;

-- 1e. Column-level UPDATE grant (see 20260511000000): the rep may record WHY
-- they dismissed a scout suggestion. Every other new column is service-role-only.
GRANT UPDATE (status, resolved_at, resolved_lead_id, dismiss_reason)
  ON public.lead_candidates
  TO authenticated;

COMMENT ON COLUMN public.lead_candidates.contact_email IS
  'Normalized: lowercased, plus-aliasing stripped. NULL only for source=ai_scout before enrichment.';
COMMENT ON COLUMN public.lead_candidates.provider_person_id IS
  'Lead Scout: the provider''s person id (e.g. Apollo person id). Unique per (workspace, provider) for scout rows.';
COMMENT ON COLUMN public.lead_candidates.dismiss_reason IS
  'Lead Scout: rep-chosen reason when dismissing a scout suggestion. The only new column writable by authenticated.';

-- ── 2. leads.source_type: allow 'ai_scout' ─────────────────────────────────
-- Last defined in 20260324132908; no later migration redefines it.
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_source_type_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_source_type_check CHECK (source_type IN (
  'outbound_prospecting', 'contact_form', 'gmail_inbound',
  'event_lead', 'referral', 'csv_import', 'manual_entry', 'whatsapp_inbound',
  'ai_scout'
));

-- ── 3. scout_profiles: what each rep's Scout looks for ─────────────────────

CREATE TABLE IF NOT EXISTS public.scout_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  -- titles, seniorities, industries, employee ranges, locations, keywords,
  -- exclusions, anchor lead ids
  profile_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_sentence  TEXT,
  weekly_target     INTEGER NOT NULL DEFAULT 25 CHECK (weekly_target IN (10, 25, 50, 100)),
  delivery_dow      INTEGER NOT NULL DEFAULT 1 CHECK (delivery_dow BETWEEN 0 AND 6),
  delivery_hour     INTEGER NOT NULL DEFAULT 7 CHECK (delivery_hour BETWEEN 0 AND 23),
  auto_approve      BOOLEAN NOT NULL DEFAULT false,
  approved_batches  INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active profile per rep per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scout_profiles_one_active_per_owner
  ON public.scout_profiles (workspace_id, owner_user_id)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS scout_profiles_set_updated_at ON public.scout_profiles;
CREATE TRIGGER scout_profiles_set_updated_at
  BEFORE UPDATE ON public.scout_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 4. scout_runs: one row per search / weekly batch / enrichment pass ─────

CREATE TABLE IF NOT EXISTS public.scout_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  profile_id        UUID REFERENCES public.scout_profiles(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('sample', 'weekly', 'enrich')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  candidates_found  INTEGER NOT NULL DEFAULT 0,
  candidates_kept   INTEGER NOT NULL DEFAULT 0,
  apollo_credits    INTEGER NOT NULL DEFAULT 0,
  lusha_credits     INTEGER NOT NULL DEFAULT 0,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_scout_runs_workspace_started
  ON public.scout_runs (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scout_runs_profile
  ON public.scout_runs (profile_id);

-- ── 5. RLS (style copied from 20260429180000_lead_candidates_pipeline.sql) ──

ALTER TABLE public.scout_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scout_runs     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can view scout profiles" ON public.scout_profiles;
CREATE POLICY "Workspace members can view scout profiles"
  ON public.scout_profiles FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Writes: the profile's owner (who must be a member) or a workspace admin.
DROP POLICY IF EXISTS "Owner or admin can insert scout profiles" ON public.scout_profiles;
CREATE POLICY "Owner or admin can insert scout profiles"
  ON public.scout_profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (owner_user_id = auth.uid() OR public.is_workspace_admin(workspace_id, auth.uid()))
  );

DROP POLICY IF EXISTS "Owner or admin can update scout profiles" ON public.scout_profiles;
CREATE POLICY "Owner or admin can update scout profiles"
  ON public.scout_profiles FOR UPDATE
  TO authenticated
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (owner_user_id = auth.uid() OR public.is_workspace_admin(workspace_id, auth.uid()))
  )
  WITH CHECK (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (owner_user_id = auth.uid() OR public.is_workspace_admin(workspace_id, auth.uid()))
  );

DROP POLICY IF EXISTS "Owner or admin can delete scout profiles" ON public.scout_profiles;
CREATE POLICY "Owner or admin can delete scout profiles"
  ON public.scout_profiles FOR DELETE
  TO authenticated
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (owner_user_id = auth.uid() OR public.is_workspace_admin(workspace_id, auth.uid()))
  );

DROP POLICY IF EXISTS "Service role full access on scout profiles" ON public.scout_profiles;
CREATE POLICY "Service role full access on scout profiles"
  ON public.scout_profiles FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- scout_runs: members read; only the Scout edge functions (service role) write.
DROP POLICY IF EXISTS "Workspace members can view scout runs" ON public.scout_runs;
CREATE POLICY "Workspace members can view scout runs"
  ON public.scout_runs FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Service role full access on scout runs" ON public.scout_runs;
CREATE POLICY "Service role full access on scout runs"
  ON public.scout_runs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── 6. Workspace-level switches (workspace_automation_settings) ─────────────
-- Missing row = Scout off. scout_enabled is the master switch.

ALTER TABLE public.workspace_automation_settings
  ADD COLUMN IF NOT EXISTS scout_enabled    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scout_weekly_cap INTEGER NOT NULL DEFAULT 50 CHECK (scout_weekly_cap >= 0),
  ADD COLUMN IF NOT EXISTS scout_allow_eu   BOOLEAN NOT NULL DEFAULT false;

-- scout_enabled / scout_weekly_cap spend DrivePilot's Apollo + Lusha credits,
-- so they are founder-controlled (service role / SQL editor), not workspace-
-- admin-writable through the existing "admins can manage" policy. A trigger
-- (rather than column grants) keeps the table's existing grants untouched:
-- requests carrying an authenticated/anon JWT keep the old values on UPDATE
-- and get the defaults on INSERT. scout_allow_eu stays admin-writable (a
-- workspace compliance choice).
CREATE OR REPLACE FUNCTION public.guard_scout_billing_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  IF jwt_role IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.scout_enabled := false;
      NEW.scout_weekly_cap := 50;
    ELSE
      NEW.scout_enabled := OLD.scout_enabled;
      NEW.scout_weekly_cap := OLD.scout_weekly_cap;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_automation_settings_guard_scout ON public.workspace_automation_settings;
CREATE TRIGGER workspace_automation_settings_guard_scout
  BEFORE INSERT OR UPDATE ON public.workspace_automation_settings
  FOR EACH ROW EXECUTE FUNCTION public.guard_scout_billing_settings();

COMMENT ON TABLE public.scout_profiles IS
  'Lead Scout: what each rep''s Scout searches for. One active profile per (workspace, owner).';
COMMENT ON TABLE public.scout_runs IS
  'Lead Scout: audit row per sample/weekly/enrich run, with provider credits spent. Service-role writes only.';
COMMENT ON COLUMN public.workspace_automation_settings.scout_enabled IS
  'Lead Scout master switch. false (or no row) = all Scout UI hidden and every Scout function no-ops. Founder-controlled.';
COMMENT ON COLUMN public.workspace_automation_settings.scout_weekly_cap IS
  'Lead Scout: max prospects per week for the whole workspace. Founder-controlled.';
