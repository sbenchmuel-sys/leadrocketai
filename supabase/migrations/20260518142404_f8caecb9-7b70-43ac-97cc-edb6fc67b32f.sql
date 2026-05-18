ALTER TABLE public.outlook_subscriptions
  ADD COLUMN IF NOT EXISTS error_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.outlook_subscriptions.error_count IS
  'Consecutive renewal/create failures since the last success. Reset to 0 on any successful PATCH/CREATE. Used by outlook-subscription-check to avoid escalating a single transient failure into an account-level error.';