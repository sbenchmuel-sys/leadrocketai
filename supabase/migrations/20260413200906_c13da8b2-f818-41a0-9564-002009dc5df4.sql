-- Add trigger to invalidate lead_context_cache when new timeline items are inserted
-- This ensures AI always has fresh conversation context including SMS/WhatsApp replies
CREATE OR REPLACE FUNCTION public.invalidate_lead_context_on_timeline()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.lead_context_cache WHERE lead_id = NEW.lead_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invalidate_cache_on_timeline_insert
  AFTER INSERT ON public.lead_timeline_items
  FOR EACH ROW
  EXECUTE FUNCTION public.invalidate_lead_context_on_timeline();