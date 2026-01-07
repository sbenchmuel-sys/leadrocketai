-- Fix: Increment meeting_summary_count when meeting packs are created/deleted

-- Create function to update meeting_summary_count
CREATE OR REPLACE FUNCTION public.update_lead_meeting_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.leads 
    SET meeting_summary_count = meeting_summary_count + 1,
        stage = 'post_meeting',
        last_activity_at = now()
    WHERE id = NEW.lead_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.leads 
    SET meeting_summary_count = GREATEST(meeting_summary_count - 1, 0)
    WHERE id = OLD.lead_id;
    -- Recalculate stage if no more meetings
    UPDATE public.leads
    SET stage = CASE
      WHEN meeting_summary_count <= 1 AND last_inbound_at IS NOT NULL THEN 'engaged'
      WHEN meeting_summary_count <= 1 AND first_outbound_at IS NOT NULL THEN 'contacted'
      ELSE 'new'
    END
    WHERE id = OLD.lead_id AND meeting_summary_count <= 1;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger for meeting_packs
DROP TRIGGER IF EXISTS trigger_update_lead_meeting_count ON public.meeting_packs;
CREATE TRIGGER trigger_update_lead_meeting_count
AFTER INSERT OR DELETE ON public.meeting_packs
FOR EACH ROW
EXECUTE FUNCTION public.update_lead_meeting_count();

-- Fix existing data: update meeting_summary_count and stage for leads with meeting packs
UPDATE public.leads l
SET 
  meeting_summary_count = (SELECT COUNT(*) FROM public.meeting_packs mp WHERE mp.lead_id = l.id),
  stage = 'post_meeting'
WHERE EXISTS (SELECT 1 FROM public.meeting_packs mp WHERE mp.lead_id = l.id);