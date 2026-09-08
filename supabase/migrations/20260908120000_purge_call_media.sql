-- 20260908120000_purge_call_media.sql
-- C1/10 — make the "call audio + transcripts auto-purge after 90 days" public
-- commitment REAL. Until now `call_settings.audio_retention_days` (default 90)
-- was read by nothing at all: recordings, transcripts and analyses accumulated
-- forever.
--
-- Ships DISABLED on purpose. The job is created with `active = false` so nothing
-- is deleted until the founder deliberately turns it on:
--
--   UPDATE cron.job SET active = true WHERE jobname = 'call-media-purge';
--
-- Verify before enabling (dry run — counts only, deletes nothing):
--   SELECT count(*) FROM public.call_recordings r
--     JOIN public.call_sessions s ON s.id = r.call_session_id
--     LEFT JOIN public.call_settings cs ON cs.workspace_id = s.workspace_id
--    WHERE COALESCE(s.ended_at, s.started_at, r.created_at)
--          < now() - make_interval(days => COALESCE(cs.audio_retention_days, 90));
--
-- Reversible by forward fix: re-running this file replaces the function and
-- re-creates the job (again disabled). Nothing is dropped.
--
-- No cron-dispatcher target is added: this purge is pure SQL, exactly like
-- `expire_old_messages()`, so an edge-function hop would be dead weight and an
-- extra failure mode. The job calls the function directly.

-- ============================================================
-- purge_call_media() — per-workspace retention, defaults to 90 days
-- ============================================================
CREATE OR REPLACE FUNCTION public.purge_call_media()
RETURNS TABLE(
  recordings_purged integer,
  transcripts_purged integer,
  analyses_purged integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recordings integer := 0;
  v_transcripts integer := 0;
  v_analyses integer := 0;
BEGIN
  -- 1. Recordings: drop the audio pointers and mark the row purged. The
  --    call_recordings ROW is kept (it is the audit trail that a call was
  --    recorded); only the media references go. The Storage objects themselves
  --    are removed by a follow-up sweeper — see the caveat in CLAUDE.md.
  --
  --    Age is measured from the end of the call; the COALESCE fallbacks keep a
  --    session with missing timestamps from being treated as either infinitely
  --    old or never expiring. Retention is per workspace
  --    (call_settings.audio_retention_days), defaulting to 90 days.
  WITH expired AS (
    SELECT s.id
    FROM public.call_sessions s
    LEFT JOIN public.call_settings cs ON cs.workspace_id = s.workspace_id
    WHERE COALESCE(s.ended_at, s.started_at, s.created_at)
          < now() - make_interval(days => GREATEST(COALESCE(cs.audio_retention_days, 90), 1))
  ), purged AS (
    UPDATE public.call_recordings r
    SET twilio_recording_url = NULL,
        storage_url = NULL,
        storage_path = NULL,
        status = 'purged'
    WHERE r.call_session_id IN (SELECT id FROM expired)
      AND (r.twilio_recording_url IS NOT NULL OR r.storage_url IS NOT NULL OR r.storage_path IS NOT NULL)
    RETURNING 1
  )
  SELECT count(*) INTO v_recordings FROM purged;

  -- 2. Transcripts: drop every text form. Language / confidence / status stay.
  WITH expired AS (
    SELECT s.id
    FROM public.call_sessions s
    LEFT JOIN public.call_settings cs ON cs.workspace_id = s.workspace_id
    WHERE COALESCE(s.ended_at, s.started_at, s.created_at)
          < now() - make_interval(days => GREATEST(COALESCE(cs.audio_retention_days, 90), 1))
  ), purged AS (
    UPDATE public.call_transcripts t
    SET segments_json = '[]'::jsonb,
        full_text = NULL,
        raw_full_text = NULL,
        clean_full_text = NULL,
        llm_formatted_text = NULL
    WHERE t.call_session_id IN (SELECT id FROM expired)
      AND (t.full_text IS NOT NULL
           OR t.raw_full_text IS NOT NULL
           OR t.clean_full_text IS NOT NULL
           OR t.llm_formatted_text IS NOT NULL
           OR t.segments_json <> '[]'::jsonb)
    RETURNING 1
  )
  SELECT count(*) INTO v_transcripts FROM purged;

  -- 3. Analyses: the AI summary is a durable paraphrase, NOT raw call content,
  --    and the same rule the email purge uses (metadata + ai_summary preserved
  --    indefinitely) applies here. Only the quoted evidence — which contains
  --    verbatim speech from the recording — is stripped.
  WITH expired AS (
    SELECT s.id
    FROM public.call_sessions s
    LEFT JOIN public.call_settings cs ON cs.workspace_id = s.workspace_id
    WHERE COALESCE(s.ended_at, s.started_at, s.created_at)
          < now() - make_interval(days => GREATEST(COALESCE(cs.audio_retention_days, 90), 1))
  ), purged AS (
    UPDATE public.call_analyses a
    SET signals_json = '{}'::jsonb
    WHERE a.call_session_id IN (SELECT id FROM expired)
      AND a.signals_json IS NOT NULL
      AND a.signals_json <> '{}'::jsonb
    RETURNING 1
  )
  SELECT count(*) INTO v_analyses FROM purged;

  recordings_purged := v_recordings;
  transcripts_purged := v_transcripts;
  analyses_purged := v_analyses;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_call_media() FROM PUBLIC, anon, authenticated;

-- `status` gains a 'purged' value. The original CHECK constraint listed only
-- ('completed','downloaded','failed','skipped_short').
ALTER TABLE public.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_status_check;
ALTER TABLE public.call_recordings ADD CONSTRAINT call_recordings_status_check
  CHECK (status IN ('completed','downloaded','failed','skipped_short','purged'));

-- ============================================================
-- Cron job — created DISABLED (active = false)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN SELECT jobid FROM cron.job WHERE jobname = 'call-media-purge' LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- Daily at 03:30 UTC, when it is eventually enabled.
SELECT cron.schedule(
  'call-media-purge',
  '30 3 * * *',
  $cron$ SELECT public.purge_call_media(); $cron$
);

-- SHIPPED OFF. The founder flips this to true when they are ready.
UPDATE cron.job SET active = false WHERE jobname = 'call-media-purge';
