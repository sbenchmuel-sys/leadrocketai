-- ═══════════════════════════════════════════════════════════════════
-- Let users ADD timeline rows for leads they own (or admin) — fixes every
-- manual "Add interaction" save.
--
-- insertInteraction() (src/lib/supabaseQueries.ts) is timeline-first: it
-- upserts lead_timeline_items from the browser and throws if that fails.
-- lead_timeline_items only ever had SELECT (members), UPDATE (lead owner) and
-- service_role policies — no INSERT for `authenticated` — so RLS rejected the
-- write and nothing was saved. Broken callers: Add Interaction (all 5 types),
-- Timeline "Log WhatsApp reply", Bulk move-to-nurture notes, sequenceUpdater
-- notes. Server-side writers use service_role and were unaffected.
--
-- Rule mirrors the existing `interactions` INSERT policy (lead owner OR
-- workspace admin), plus: the row's workspace_id must be the lead's own
-- workspace, so a row can't be filed into a workspace the lead isn't in.
-- ═══════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Lead owners and admins can add timeline items" ON public.lead_timeline_items;
CREATE POLICY "Lead owners and admins can add timeline items"
  ON public.lead_timeline_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.id = lead_timeline_items.lead_id
        AND l.workspace_id = lead_timeline_items.workspace_id
        AND (l.owner_user_id = auth.uid()
             OR public.is_workspace_admin(l.workspace_id, auth.uid()))
    )
  );
