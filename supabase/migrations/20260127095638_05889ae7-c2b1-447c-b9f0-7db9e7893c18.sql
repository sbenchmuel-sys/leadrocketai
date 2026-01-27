-- Add action_dismissed_at column to track when an action was dismissed
-- This prevents gmail-sync from overwriting manual dismissals
ALTER TABLE leads ADD COLUMN IF NOT EXISTS action_dismissed_at TIMESTAMP WITH TIME ZONE;