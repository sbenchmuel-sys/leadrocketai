-- Add wa_opted_in to leads for per-lead WhatsApp automation opt-in
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS wa_opted_in boolean NOT NULL DEFAULT false;

-- Add wa_automation_enabled to workspace_profiles for workspace-level WA auto-send control  
-- (extends existing automation_enabled in cadence_settings JSON — no new column needed)
-- Just add a comment documenting the intent
COMMENT ON COLUMN public.leads.wa_opted_in IS 
  'Whether this lead has explicitly opted in to WhatsApp automation. Required alongside workspace cadence_settings.whatsapp.automation_enabled for any WA auto-sends.';