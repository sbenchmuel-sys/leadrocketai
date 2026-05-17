-- Trigger function: keep leads.last_activity_at in sync with the latest timeline event.
CREATE OR REPLACE FUNCTION public.sync_lead_last_activity_from_timeline()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Clock-skew guard: ignore obviously-future events (>5 min ahead).
  IF NEW.occurred_at IS NULL OR NEW.occurred_at > now() + interval '5 minutes' THEN
    RETURN NEW;
  END IF;

  IF NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.leads
  SET last_activity_at = GREATEST(
    COALESCE(last_activity_at, 'epoch'::timestamptz),
    NEW.occurred_at
  )
  WHERE id = NEW.lead_id
    AND (last_activity_at IS NULL OR NEW.occurred_at > last_activity_at);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_lead_last_activity ON public.lead_timeline_items;

CREATE TRIGGER trg_sync_lead_last_activity
AFTER INSERT OR UPDATE OF occurred_at, lead_id
ON public.lead_timeline_items
FOR EACH ROW
EXECUTE FUNCTION public.sync_lead_last_activity_from_timeline();

-- One-time backfill: recompute last_activity_at from the canonical timeline.
UPDATE public.leads l
SET last_activity_at = COALESCE(
  (SELECT MAX(occurred_at)
     FROM public.lead_timeline_items
    WHERE lead_id = l.id
      AND occurred_at <= now() + interval '5 minutes'),
  l.created_at,
  l.last_activity_at
);