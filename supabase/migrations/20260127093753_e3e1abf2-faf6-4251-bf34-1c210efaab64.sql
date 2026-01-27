-- Add nurture tracking fields to leads table
ALTER TABLE leads ADD COLUMN IF NOT EXISTS nurture_cadence TEXT CHECK (nurture_cadence IN ('weekly', 'biweekly', 'monthly'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS mode_changed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_nurture_eligible BOOLEAN DEFAULT false;