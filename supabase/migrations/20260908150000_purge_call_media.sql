-- 20260908150000_purge_call_media.sql
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
-- Audit after enabling (must return 0 — no expired analysis still holds a
-- verbatim transcript quote in any of its three JSON columns):
--   SELECT count(*) FROM public.call_analyses a
--     JOIN public.call_sessions s ON s.id = a.call_session_id
--     LEFT JOIN public.call_settings cs ON cs.workspace_id = s.workspace_id
--    WHERE COALESCE(s.ended_at, s.started_at, s.created_at)
--          < now() - make_interval(days => GREATEST(COALESCE(cs.audio_retention_days, 90), 1))
--      AND (
--        (a.signals_json IS NOT NULL AND a.signals_json <> '{}'::jsonb)
--        OR public.strip_call_evidence(a.action_items_json) IS DISTINCT FROM a.action_items_json
--        OR public.strip_call_evidence(a.recommended_next_steps_json)
--             IS DISTINCT FROM a.recommended_next_steps_json
--      );
--
-- Reversible by forward fix: re-running this file replaces the function and
-- re-creates the job (again disabled). Nothing is dropped.
--
-- No cron-dispatcher target is added: this purge is pure SQL, exactly like
-- `expire_old_messages()`, so an edge-function hop would be dead weight and an
-- extra failure mode. The job calls the function directly.

-- ============================================================
-- strip_call_evidence() — remove the quoted-evidence arrays from a JSON array
-- of analysis items, leaving every other (derived, non-verbatim) field intact.
--
-- Pure and IMMUTABLE, so it is used twice below: once to rewrite the value and
-- once, as `strip(x) IS DISTINCT FROM x`, as the "does this row still hold
-- quotes?" eligibility test. A non-array (or NULL) input is returned unchanged,
-- which makes the test false and the purge a no-op for it.
-- ============================================================
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

  -- 3. Analyses: the AI summaries (summary_short / summary_long) are durable
  --    paraphrases, NOT raw call content — the same rule the email purge uses
  --    (metadata + ai_summary preserved indefinitely) applies here, so they stay.
  --    Everything holding verbatim speech goes:
  --      • signals_json                — the WHOLE normalized analysis object
  --        call-analyze writes, evidence quotes and all. Cleared outright; every
  --        distinct field a rep reads from it is also stored in a dedicated
  --        column (summaries, action items, next steps).
  --      • action_items_json           — each item's `evidence[].quote` is an
  --      • recommended_next_steps_json   exact transcript fragment (call-analyze
  --        prunes any quote that is NOT literally present in the transcript, so
  --        what survives is verbatim by construction). Only the `evidence` array
  --        is removed; the derived text / owner / priority / rank / rationale /
  --        confidence the rep works from are kept.
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
      -- Any of the three still holding quotes makes the row eligible. Rows whose
      -- signals_json was already emptied by an earlier version of this function
      -- are therefore revisited and finished off, instead of being skipped
      -- forever by a signals_json-only predicate.
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
