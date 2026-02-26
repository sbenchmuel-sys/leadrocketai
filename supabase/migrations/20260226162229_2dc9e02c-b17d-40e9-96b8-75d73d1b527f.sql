
-- Add unique constraints for callSid and recordingSid
ALTER TABLE public.call_sessions ADD CONSTRAINT call_sessions_call_sid_unique UNIQUE (call_sid);
ALTER TABLE public.call_recordings ADD CONSTRAINT call_recordings_recording_sid_unique UNIQUE (recording_sid);
