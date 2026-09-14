-- ═══════════════════════════════════════════════════════════════════
-- Unit G-B: the Outlook webhook's ADVANCE-ONLY recency writes.
--
-- The webhook writes `leads.last_inbound_at` / `last_activity_at` with the
-- message's real receivedDateTime. Those columns must never move BACKWARDS:
-- `last_inbound_at` is what syncEngine.buildLeadUpdate compares against
-- `action_dismissed_at` to decide whether to resurface a lead, so a rewind
-- silently un-resurfaces a lead a rep has handled.
--
-- Two ways backwards can happen: Graph fires on a message being MOVED INTO the
-- folder (an old mail rescued from Junk), and Graph delivers notifications in
-- PARALLEL. Computing max() in TypeScript over a snapshot fixes only the first.
-- So the comparison lives in the UPDATE's own WHERE clause, and this file
-- exercises that exact predicate against a real Postgres.
--
-- The predicate under test — what processor.ts sends via PostgREST as
--   .update({ <col>: $ts }).eq("id", $lead).or("<col>.is.null,<col>.lt.$ts")
-- is, in SQL:
--   UPDATE leads SET <col> = $ts
--    WHERE id = $lead AND (<col> IS NULL OR <col> < $ts);
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

INSERT INTO public.workspaces (id, name) VALUES ('00000000-0000-0000-0000-00000000eeee', 'WS E');
INSERT INTO public.leads (id, workspace_id, name, email) VALUES
  ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000eeee', 'Recency', 'recency@ok.example');

-- 1. THE NULL CASE. A lead's FIRST inbound has last_inbound_at IS NULL. If the
--    predicate got this wrong the column would never be set at all.
UPDATE public.leads SET last_inbound_at = '2026-06-01T12:00:00Z'
 WHERE id = '00000000-0000-0000-0000-00000000e101'
   AND (last_inbound_at IS NULL OR last_inbound_at < '2026-06-01T12:00:00Z');
DO $$ BEGIN
  IF (SELECT last_inbound_at FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000e101')
     IS DISTINCT FROM '2026-06-01T12:00:00Z'::timestamptz
  THEN RAISE EXCEPTION 'first inbound (NULL -> value) did not set the column'; END IF;
END $$;

-- 2. FORWARD moves are applied.
UPDATE public.leads SET last_inbound_at = '2026-06-02T09:00:00Z'
 WHERE id = '00000000-0000-0000-0000-00000000e101'
   AND (last_inbound_at IS NULL OR last_inbound_at < '2026-06-02T09:00:00Z');
DO $$ BEGIN
  IF (SELECT last_inbound_at FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000e101')
     <> '2026-06-02T09:00:00Z'::timestamptz
  THEN RAISE EXCEPTION 'a newer timestamp was not applied'; END IF;
END $$;

-- 3. BACKWARD moves are refused — the Junk-folder-rescue case, and the losing
--    half of a concurrent delivery. The statement must match ZERO rows.
DO $$
DECLARE n int;
BEGIN
  UPDATE public.leads SET last_inbound_at = '2026-01-01T00:00:00Z'
   WHERE id = '00000000-0000-0000-0000-00000000e101'
     AND (last_inbound_at IS NULL OR last_inbound_at < '2026-01-01T00:00:00Z');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'an older timestamp matched % row(s) — it must match none', n; END IF;
  IF (SELECT last_inbound_at FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000e101')
     <> '2026-06-02T09:00:00Z'::timestamptz
  THEN RAISE EXCEPTION 'an older timestamp moved the column backwards'; END IF;
END $$;

-- 4. An EQUAL timestamp is a no-op (a redelivered notification for the same
--    message must not churn the row).
DO $$
DECLARE n int;
BEGIN
  UPDATE public.leads SET last_inbound_at = '2026-06-02T09:00:00Z'
   WHERE id = '00000000-0000-0000-0000-00000000e101'
     AND (last_inbound_at IS NULL OR last_inbound_at < '2026-06-02T09:00:00Z');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'an equal timestamp should match no rows, matched %', n; END IF;
END $$;

-- 5. THE COLUMNS MOVE INDEPENDENTLY. A lead can have a later outbound, so
--    last_activity_at can be NEWER than last_inbound_at. An inbound older than
--    that activity must still advance last_inbound_at while leaving
--    last_activity_at alone — which is why processor.ts issues one statement
--    per column rather than one shared guard.
UPDATE public.leads SET last_activity_at = '2026-07-01T00:00:00Z'
 WHERE id = '00000000-0000-0000-0000-00000000e101';
UPDATE public.leads SET last_inbound_at = '2026-06-15T00:00:00Z'
 WHERE id = '00000000-0000-0000-0000-00000000e101'
   AND (last_inbound_at IS NULL OR last_inbound_at < '2026-06-15T00:00:00Z');
UPDATE public.leads SET last_activity_at = '2026-06-15T00:00:00Z'
 WHERE id = '00000000-0000-0000-0000-00000000e101'
   AND (last_activity_at IS NULL OR last_activity_at < '2026-06-15T00:00:00Z');
DO $$ BEGIN
  IF (SELECT last_inbound_at FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000e101')
     <> '2026-06-15T00:00:00Z'::timestamptz
  THEN RAISE EXCEPTION 'last_inbound_at should have advanced to the new inbound'; END IF;
  IF (SELECT last_activity_at FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000e101')
     <> '2026-07-01T00:00:00Z'::timestamptz
  THEN RAISE EXCEPTION 'last_activity_at was dragged backwards by an older inbound'; END IF;
END $$;

-- 6. Postgres GREATEST ignores NULL arguments (it does NOT propagate them the
--    way the SQL standard and MySQL do). Pinned here because the review asked
--    the NULL semantics be checked rather than assumed: it documents that the
--    GREATEST formulation would ALSO have been NULL-safe, and guards the claim
--    made in processor.ts's comment against a future engine change.
DO $$ BEGIN
  IF GREATEST(NULL::timestamptz, '2026-01-01T00:00:00Z'::timestamptz)
     IS DISTINCT FROM '2026-01-01T00:00:00Z'::timestamptz
  THEN RAISE EXCEPTION 'GREATEST no longer ignores NULL — revisit the recency comment in processor.ts'; END IF;
  IF GREATEST(NULL::timestamptz, NULL::timestamptz) IS NOT NULL
  THEN RAISE EXCEPTION 'GREATEST(NULL, NULL) should be NULL'; END IF;
END $$;

SELECT 'outlook_webhook_recency: all checks passed' AS result;
