-- Fix the stuck call session from the recent call:
-- Update the parent session to completed with duration
UPDATE public.call_sessions
SET status = 'completed',
    duration_sec = 99,
    ended_at = '2026-04-13T21:38:21Z',
    answered_at = '2026-04-13T21:36:43Z',
    updated_at = now()
WHERE call_sid = 'CA1009e64547ce6052860dafc8a5999541';

-- Delete the orphan child-leg session
DELETE FROM public.call_sessions
WHERE call_sid = 'CA3e2066561159df93a09e6a07ab34215c';