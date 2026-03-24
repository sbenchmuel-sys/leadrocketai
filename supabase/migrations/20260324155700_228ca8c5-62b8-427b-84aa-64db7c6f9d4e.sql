-- Add dedicated hidden column for durable hide/unhide state
ALTER TABLE public.lead_timeline_items
ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

-- Index for the most common query pattern: non-hidden items for a lead, sorted by time
CREATE INDEX IF NOT EXISTS idx_timeline_lead_visible_time
ON public.lead_timeline_items (lead_id, occurred_at DESC)
WHERE hidden = false;

-- Backfill: migrate any hidden=true from status_json into the new column
UPDATE public.lead_timeline_items
SET hidden = true
WHERE (status_json->>'hidden')::boolean = true;