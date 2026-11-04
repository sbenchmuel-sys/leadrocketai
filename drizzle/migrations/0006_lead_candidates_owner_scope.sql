-- ═══════════════════════════════════════════════════════════════════
-- Pending leads are visible to their owner only — admins included (3 Nov 2026).
--
-- Reported: a rep in Paythings saw 25 pending leads that came from the admin's
-- (Cliff's) mailbox. Two causes:
--  1. lead_candidates SELECT/UPDATE policies only checked workspace membership,
--     so every member saw (and could approve/dismiss) every candidate.
--  2. The Outlook scanners in detect-lead-candidates and lookback-seed-candidates
--     wrote owner_user_id = NULL ("Outlook mail_accounts have no user_id" — stale
--     since mail_accounts.user_id was added). Fixed in the same PR.
--
-- Founder decision: everyone, admins included, sees and resolves only their own
-- pending leads (stricter than leads, where admins see all). Ownerless rows are
-- visible to nobody; the backfill below leaves none on prod today.
-- ai_scout candidates already carry the profile owner.
--
-- Backfill: ownerless candidates go to the workspace's Outlook mailbox owner when
-- there is exactly one (true for every affected workspace on 3 Nov: Paythings,
-- DrivePilot Outreach, Personal Workspace). Otherwise they stay NULL (hidden).
-- The pending-unique index is (workspace_id, lower(contact_email)), so this can't
-- collide.
-- ═══════════════════════════════════════════════════════════════════

UPDATE public.lead_candidates c
   SET owner_user_id = o.user_id
  FROM (SELECT workspace_id, (array_agg(DISTINCT user_id))[1] AS user_id
          FROM public.mail_accounts
         WHERE provider = 'outlook' AND user_id IS NOT NULL
         GROUP BY workspace_id
        HAVING count(DISTINCT user_id) = 1) o
 WHERE c.owner_user_id IS NULL
   AND c.workspace_id = o.workspace_id;

DROP POLICY IF EXISTS "Workspace members can view lead candidates" ON public.lead_candidates;
CREATE POLICY "Owners can view their lead candidates"
  ON public.lead_candidates
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid())
         AND owner_user_id = auth.uid());

-- Column grants from 20260511000000 still limit this to status / resolved_at /
-- resolved_lead_id.
DROP POLICY IF EXISTS "Workspace members can update lead candidate status" ON public.lead_candidates;
CREATE POLICY "Owners can update their lead candidate status"
  ON public.lead_candidates
  FOR UPDATE TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid())
         AND owner_user_id = auth.uid())
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid())
         AND owner_user_id = auth.uid());