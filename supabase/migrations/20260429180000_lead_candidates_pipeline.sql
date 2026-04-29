-- 20260429180000_lead_candidates_pipeline.sql
--
-- Lead Candidates Pipeline V1 — data layer
-- Spec: https://github.com/sbenchmuel-sys/leadrocketai/issues/3
--
-- Adds the review queue for auto-detected lead suggestions plus the
-- workspace-level dismiss-list and internal-domain tables used by the
-- detection filter chain.
--
-- Net-new tables only — no existing code reads or writes them yet, so this
-- migration is non-disruptive. Subsequent PRs (#4 detection hook, #5 AI
-- scoring, #6 lookback seed, #7 UI) build on top.

-- ── 1. lead_candidates: the review queue ────────────────────────────────────

CREATE TABLE public.lead_candidates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  contact_email       TEXT NOT NULL,
  contact_name        TEXT,
  company_domain      TEXT,

  source              TEXT NOT NULL CHECK (source IN (
    'outbound',
    'inbound_explicit',
    'inbound_referral',
    'lookback_seed'
  )),

  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_email_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  email_count         INTEGER NOT NULL DEFAULT 1,

  subject_snippet     TEXT,
  body_snippet        TEXT,

  ai_score            INTEGER CHECK (ai_score IS NULL OR (ai_score >= 0 AND ai_score <= 100)),
  ai_reason           TEXT,

  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'approved',
    'dismissed',
    'snoozed'
  )),

  resolved_at         TIMESTAMPTZ,
  resolved_lead_id    UUID REFERENCES public.leads(id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One PENDING candidate per (workspace, email). Approved/dismissed rows are
-- preserved as history; if a candidate later returns, a new pending row may be
-- created without conflict.
CREATE UNIQUE INDEX idx_lead_candidates_unique_pending
  ON public.lead_candidates (workspace_id, contact_email)
  WHERE status = 'pending';

CREATE INDEX idx_lead_candidates_workspace_status
  ON public.lead_candidates (workspace_id, status);

CREATE INDEX idx_lead_candidates_workspace_last_email
  ON public.lead_candidates (workspace_id, last_email_at DESC);

CREATE INDEX idx_lead_candidates_owner
  ON public.lead_candidates (owner_user_id);

-- ── 2. workspace_dismissed_domains: "always reject this domain" ─────────────

CREATE TABLE public.workspace_dismissed_domains (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  domain                 TEXT NOT NULL,
  dismissed_by_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, domain)
);

CREATE INDEX idx_workspace_dismissed_domains_workspace
  ON public.workspace_dismissed_domains (workspace_id);

-- ── 3. workspace_dismissed_emails: "always reject this email" ───────────────

CREATE TABLE public.workspace_dismissed_emails (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email                  TEXT NOT NULL,
  dismissed_by_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, email)
);

CREATE INDEX idx_workspace_dismissed_emails_workspace
  ON public.workspace_dismissed_emails (workspace_id);

-- ── 4. workspace_internal_domains: extra teammate domains ───────────────────
-- Detection filter chain treats these as "internal" beyond the rep's own
-- mailbox domain — e.g. for orgs that operate multiple domains.

CREATE TABLE public.workspace_internal_domains (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  domain              TEXT NOT NULL,
  added_by_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, domain)
);

CREATE INDEX idx_workspace_internal_domains_workspace
  ON public.workspace_internal_domains (workspace_id);

-- ── updated_at trigger ──────────────────────────────────────────────────────

CREATE TRIGGER lead_candidates_set_updated_at
  BEFORE UPDATE ON public.lead_candidates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Row-level security ──────────────────────────────────────────────────────

ALTER TABLE public.lead_candidates                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_dismissed_domains    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_dismissed_emails     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_internal_domains     ENABLE ROW LEVEL SECURITY;

-- lead_candidates: members read; members update (approve/dismiss).
-- INSERTs always go through service role (sync + AI pipeline write candidates).

CREATE POLICY "Workspace members can view lead candidates"
  ON public.lead_candidates FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can update lead candidate status"
  ON public.lead_candidates FOR UPDATE
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Service role full access on lead candidates"
  ON public.lead_candidates FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- workspace_dismissed_domains: members manage directly via Settings UI.

CREATE POLICY "Workspace members can view dismissed domains"
  ON public.workspace_dismissed_domains FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can insert dismissed domains"
  ON public.workspace_dismissed_domains FOR INSERT
  TO authenticated
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can delete dismissed domains"
  ON public.workspace_dismissed_domains FOR DELETE
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Service role full access on dismissed domains"
  ON public.workspace_dismissed_domains FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- workspace_dismissed_emails: same pattern as domains.

CREATE POLICY "Workspace members can view dismissed emails"
  ON public.workspace_dismissed_emails FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can insert dismissed emails"
  ON public.workspace_dismissed_emails FOR INSERT
  TO authenticated
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can delete dismissed emails"
  ON public.workspace_dismissed_emails FOR DELETE
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Service role full access on dismissed emails"
  ON public.workspace_dismissed_emails FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- workspace_internal_domains: same pattern.

CREATE POLICY "Workspace members can view internal domains"
  ON public.workspace_internal_domains FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can insert internal domains"
  ON public.workspace_internal_domains FOR INSERT
  TO authenticated
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can delete internal domains"
  ON public.workspace_internal_domains FOR DELETE
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Service role full access on internal domains"
  ON public.workspace_internal_domains FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Documentation comments ──────────────────────────────────────────────────

COMMENT ON TABLE public.lead_candidates IS
  'Pending Leads review queue. Sync detects external recipients, AI scores, user approves/dismisses. Spec: github issues/3.';
COMMENT ON COLUMN public.lead_candidates.contact_email IS
  'Normalized: lowercased, plus-aliasing stripped. Used for cross-workspace dedupe.';
COMMENT ON COLUMN public.lead_candidates.source IS
  'How the candidate entered the queue. Inbound sources require explicit signals.';

COMMENT ON TABLE public.workspace_dismissed_domains IS
  'Workspace-level "always reject this domain" list. Filter chain consults this before queueing.';
COMMENT ON TABLE public.workspace_dismissed_emails IS
  'Workspace-level "always reject this specific email" list. Filter chain consults this before queueing.';
COMMENT ON TABLE public.workspace_internal_domains IS
  'Extra teammate domains beyond rep mailbox domain. Filter chain excludes these from candidate generation.';
