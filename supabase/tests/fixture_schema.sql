-- ═══════════════════════════════════════════════════════════════════
-- Minimal fixture schema for exercising outreach SQL functions in a scratch
-- Postgres (see scripts/test-sql.sh). This is NOT the production schema — it is
-- the subset the functions under test read or write, shaped like the real
-- migrations (same columns, constraints and unique indexes that the functions'
-- correctness depends on), plus stubs for Supabase's auth.uid() and the
-- workspace-membership helpers so SECURITY DEFINER gates can be tested.
--
-- Keep it in step with supabase/migrations when a tested function starts
-- depending on a new column.
-- ═══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- auth.uid() stub: reads a per-session setting so tests can "sign in" as a user.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.uid', true), '')::uuid;
$$;

CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text
);

CREATE TABLE public.workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member'
);

CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workspace_members
                 WHERE workspace_id = _workspace_id AND user_id = _user_id);
$$;
CREATE OR REPLACE FUNCTION public.is_workspace_admin(_workspace_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workspace_members
                 WHERE workspace_id = _workspace_id AND user_id = _user_id AND role = 'admin');
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid,
  name text,
  company text,
  email text,
  phone text,
  linkedin_url text,
  whatsapp_number text,
  unsubscribed boolean NOT NULL DEFAULT false,
  campaign_id uuid,
  automation_mode text,
  needs_action boolean,
  stage text,
  has_future_meeting boolean,
  last_inbound_at timestamptz
);

CREATE TYPE public.campaign_step_type AS ENUM (
  'intro', 'followup', 'value_add', 'breakup', 'nurture', 're_engagement'
);

CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  send_mode text NOT NULL DEFAULT 'review'
);

CREATE TABLE public.campaign_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  step_number integer NOT NULL CHECK (step_number >= 1 AND step_number <= 10),
  step_type public.campaign_step_type NOT NULL DEFAULT 'intro',
  channel text NOT NULL DEFAULT 'email',
  cta_type text NOT NULL DEFAULT 'question',
  custom_instructions text,
  delay_days integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  variant_group text,
  include_meeting_cta boolean,
  UNIQUE (campaign_id, step_number)
);

-- Keyed by step_number (reconciled by replace_campaign_steps_reconciled).
CREATE TABLE public.campaign_step_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  variant_group text,
  subject text,
  body text,
  is_edited boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX campaign_step_content_unique
  ON public.campaign_step_content (campaign_id, step_number, COALESCE(variant_group, ''));

CREATE TABLE public.campaign_collateral (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  collateral_type text NOT NULL DEFAULT 'one_pager',
  variant_group text,
  attached_step_number integer
);

CREATE TABLE public.campaign_suppression_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email', 'domain')),
  value text NOT NULL,
  UNIQUE (workspace_id, kind, value)
);

CREATE TABLE public.campaign_enrollment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'active', 'replied', 'paused', 'completed', 'stopped')),
  current_step_number integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);
CREATE UNIQUE INDEX campaign_enrollment_one_live_per_lead
  ON public.campaign_enrollment (lead_id)
  WHERE status IN ('scheduled', 'active', 'paused');
CREATE TRIGGER update_campaign_enrollment_updated_at
  BEFORE UPDATE ON public.campaign_enrollment
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.campaign_touch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES public.campaign_enrollment(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  channel text NOT NULL
    CHECK (channel IN ('email', 'voice', 'sms', 'whatsapp', 'linkedin')),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'queued', 'sent', 'skipped', 'auto_skipped', 'failed')),
  eligible_at timestamptz,
  max_age_at timestamptz,
  call_outcome text CHECK (call_outcome IN ('got_them', 'no_answer')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, step_number)
);
CREATE TRIGGER update_campaign_touch_updated_at
  BEFORE UPDATE ON public.campaign_touch
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Roles the migrations GRANT to.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
