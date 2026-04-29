CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'dispatch-score-lead-candidate'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

SELECT cron.schedule(
  'dispatch-score-lead-candidate',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "score-lead-candidate"}'::jsonb
  ) AS request_id;
  $cron$
);

-- Kick off an immediate run so existing pending candidates get scored without waiting 10 min.
SELECT net.http_post(
  url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
  headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
  body := '{"target": "score-lead-candidate"}'::jsonb
);