
-- Step 1: Add nullable column
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id);

-- Step 2: Backfill from workspace_members
UPDATE public.leads l
SET workspace_id = (
  SELECT wm.workspace_id
  FROM public.workspace_members wm
  WHERE wm.user_id = l.owner_user_id
  ORDER BY wm.created_at ASC
  LIMIT 1
)
WHERE l.workspace_id IS NULL;

-- Step 2b: Orphaned leads (owner has no workspace) — assign to first workspace in system
UPDATE public.leads l
SET workspace_id = (
  SELECT w.id FROM public.workspaces w ORDER BY w.created_at ASC LIMIT 1
)
WHERE l.workspace_id IS NULL;

-- Step 3: NOT NULL
ALTER TABLE public.leads ALTER COLUMN workspace_id SET NOT NULL;

-- Step 4: Indexes
CREATE INDEX IF NOT EXISTS idx_leads_workspace_id ON public.leads(workspace_id);
CREATE INDEX IF NOT EXISTS idx_leads_workspace_stage ON public.leads(workspace_id, stage);

-- Cross-workspace guard trigger on contacts.lead_id
CREATE OR REPLACE FUNCTION public.enforce_contact_lead_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    PERFORM 1 FROM public.leads
    WHERE id = NEW.lead_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Contact workspace_id (%) does not match lead workspace_id for lead_id (%)', NEW.workspace_id, NEW.lead_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_contact_lead_workspace ON public.contacts;
CREATE TRIGGER trg_enforce_contact_lead_workspace
  BEFORE INSERT OR UPDATE OF lead_id ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_contact_lead_workspace();

-- Expand check constraints for WhatsApp auto-created leads
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_source_type_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_source_type_check CHECK (source_type IN (
  'outbound_prospecting', 'contact_form', 'gmail_inbound',
  'event_lead', 'referral', 'csv_import', 'manual_entry', 'whatsapp_inbound'
));

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_strategy_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_strategy_check CHECK (strategy IN ('fast', 'nurture', 'reply'));
