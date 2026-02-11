
-- Task 1.1: Add source_type (immutable once created)
ALTER TABLE public.leads
ADD COLUMN source_type text NOT NULL DEFAULT 'manual_entry';

-- Task 1.2: Add motion (updated by events)
ALTER TABLE public.leads
ADD COLUMN motion text NOT NULL DEFAULT 'outbound_prospecting';

-- Add check constraints for allowed values
ALTER TABLE public.leads
ADD CONSTRAINT leads_source_type_check CHECK (source_type IN (
  'outbound_prospecting', 'contact_form', 'gmail_inbound', 
  'event_lead', 'referral', 'csv_import', 'manual_entry'
));

ALTER TABLE public.leads
ADD CONSTRAINT leads_motion_check CHECK (motion IN (
  'outbound_prospecting', 'inbound_response', 'pre_meeting', 
  'post_meeting', 'closing', 'nurture', 'closed'
));
