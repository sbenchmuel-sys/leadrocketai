DO $$
BEGIN
  PERFORM cron.alter_job(jobid := (SELECT jobid FROM cron.job WHERE jobname = 'dispatch-message-cleanup'), active := false);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.alter_job(jobid := (SELECT jobid FROM cron.job WHERE jobname = 'expire-messages-direct'), active := false);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;