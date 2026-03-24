CREATE POLICY "Users can delete own enrichment"
ON public.entity_enrichment
FOR DELETE
TO authenticated
USING (requested_by_user_id = auth.uid());

CREATE POLICY "Users can delete own lead signals"
ON public.lead_signals
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = lead_signals.lead_id
    AND leads.owner_user_id = auth.uid()
  )
);