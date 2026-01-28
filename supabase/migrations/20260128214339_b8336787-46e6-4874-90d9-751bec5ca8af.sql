-- Add DELETE policy for drafts table
CREATE POLICY "Users can delete drafts for their leads"
ON public.drafts FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = drafts.lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

-- Move pg_cron and pg_net extensions to extensions schema
-- Note: These extensions may need to stay in their current schemas for functionality
-- We'll document that this is a known limitation