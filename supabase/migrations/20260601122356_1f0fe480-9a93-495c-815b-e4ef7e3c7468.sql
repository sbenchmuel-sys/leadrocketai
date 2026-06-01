-- Disable both purge crons until further notice.
-- Per user request: no further auto-purge of message bodies. Snippets and
-- bodies that survive will be backfilled into bullet AI summaries by the
-- backfill-inbound-drain edge function.
--
-- Both jobs are removed by name; the underlying SQL function
-- public.expire_old_messages() and the message-cleanup edge function are
-- intentionally left in place so re-enabling later is a one-line
-- cron.schedule() call.

DO $disable_purge$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = ANY(ARRAY[
      'dispatch-message-cleanup',  -- hourly edge function call
      'expire-messages'            -- hourly DB-level fallback
    ])
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$disable_purge$;