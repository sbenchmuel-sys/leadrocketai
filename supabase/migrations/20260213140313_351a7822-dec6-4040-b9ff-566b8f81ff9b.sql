ALTER TABLE public.interactions ADD COLUMN hidden boolean NOT NULL DEFAULT false;
CREATE INDEX idx_interactions_hidden ON public.interactions (lead_id, hidden) WHERE hidden = false;