ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN public.workspaces.timezone IS
  'IANA timezone name (e.g. "America/New_York", "Europe/London"). When NULL, automation-executor refuses to send for this workspace until configured. Used by checkSendWindow to compare wall-clock time correctly.';

UPDATE public.workspaces
SET timezone = 'America/New_York'
WHERE id = '9c92f7ce-38f1-49ad-baba-1a7833d6a34b'
  AND timezone IS NULL;