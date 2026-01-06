-- Enable required extensions for cron jobs
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Create a cron job to sync Gmail every 15 minutes
SELECT cron.schedule(
  'gmail-background-sync-job',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://umqhdxjtgarwkdpwsxrm.supabase.co/functions/v1/gmail-background-sync',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtcWhkeGp0Z2Fyd2tkcHdzeHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MzQ5MjYsImV4cCI6MjA4MzIxMDkyNn0.10XxIBoN9vhKyhY6n7ANsag5bRtT6roZS7guVz99Qm4"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);