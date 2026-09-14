CREATE OR REPLACE FUNCTION public.strip_call_evidence(p_items jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_items) <> 'array' THEN p_items
    ELSE COALESCE(
      (
        SELECT jsonb_agg(
                 CASE WHEN jsonb_typeof(elem) = 'object' THEN elem - 'evidence' ELSE elem END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(elem, ord)
      ),
      '[]'::jsonb
    )
  END;
$function$;

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

  WITH expired AS (
    SELECT s.id
    FROM public.call_sessions s
    LEFT JOIN public.call_settings cs ON cs.workspace_id = s.workspace_id
    WHERE COALESCE(s.ended_at, s.started_at, s.created_at)
          < now() - make_interval(days => GREATEST(COALESCE(cs.audio_retention_days, 90), 1))
  ), purged AS (
    UPDATE public.call_analyses a
    SET signals_json = '{}'::jsonb,
        action_items_json = public.strip_call_evidence(a.action_items_json),
        recommended_next_steps_json = public.strip_call_evidence(a.recommended_next_steps_json)
    WHERE a.call_session_id IN (SELECT id FROM expired)
      AND (
        (a.signals_json IS NOT NULL AND a.signals_json <> '{}'::jsonb)
        OR public.strip_call_evidence(a.action_items_json) IS DISTINCT FROM a.action_items_json
        OR public.strip_call_evidence(a.recommended_next_steps_json) IS DISTINCT FROM a.recommended_next_steps_json
      )
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

ALTER TABLE public.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_status_check;
ALTER TABLE public.call_recordings ADD CONSTRAINT call_recordings_status_check
  CHECK (status IN ('completed','downloaded','failed','skipped_short','purged'));

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

DO $sched$
DECLARE
  jid bigint;
BEGIN
  jid := cron.schedule(
    'call-media-purge',
    '30 3 * * *',
    $cron$ SELECT public.purge_call_media(); $cron$
  );
  -- SHIPPED OFF: alter_job (not a direct UPDATE on cron.job, which is not permitted).
  PERFORM cron.alter_job(jid, active := false);
END
$sched$;