CREATE OR REPLACE FUNCTION public.invalidate_lead_intelligence_on_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.lead_intelligence WHERE lead_id = COALESCE(NEW.lead_id, OLD.lead_id);
  DELETE FROM public.lead_context_cache WHERE lead_id = COALESCE(NEW.lead_id, OLD.lead_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_invalidate_intelligence_on_context
  AFTER INSERT OR UPDATE OR DELETE ON public.lead_context_items
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_lead_intelligence_on_context();