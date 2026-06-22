
-- Lock down infrastructure tables that should be service-role only.
-- RLS is already enabled and no client-facing policies exist, but lingering
-- table-level SELECT grants to anon/authenticated mean a future policy
-- mistake would immediately expose data. Revoke the grants so the surface
-- area matches the intent.

REVOKE ALL ON public.cron_run_log FROM anon, authenticated;
REVOKE ALL ON public.orchestration_log FROM anon, authenticated;

GRANT ALL ON public.cron_run_log TO service_role;
GRANT ALL ON public.orchestration_log TO service_role;
