

## Problem

Your call recordings were downloaded successfully (3 recordings with `status: downloaded`), but all 3 transcription attempts **failed** because they ran the old code that tried to use "lovable-ai" as the provider — which can't process audio. The code has since been updated to use Google Cloud Speech-to-Text (your API key is configured), but the failed transcripts are sitting there and won't automatically retry.

## Plan

### Step 1: Retry failed transcripts
- Delete the 3 failed `call_transcripts` rows so the pipeline treats them as fresh
- Re-invoke `call-transcribe` for each of the 3 call sessions that have downloaded recordings:
  - `240fa929-a4d0-4992-a43f-0dbbb6cc1363` (84s call)
  - `8bf5b872-040d-4b33-835b-b2ada09f5fe4` (69s call)  
  - `cde9279c-f0fd-4540-bda5-ec9eb04985db` (99s call)

### Step 2: Verify pipeline completes
- Check edge function logs for `call-transcribe` to confirm Google Speech API calls succeed
- Verify `call_transcripts` rows update to `status: completed` with actual transcript text
- Confirm `call-analyze` is triggered for calls meeting the 30s minimum duration

### Step 3: Verify UI display
- The CallDetail page (`/app/calls/:id`) already has full UI for transcripts, analysis summaries, action items, sentiment, and audio playback
- The lead timeline should update from generic "Phone call" to include the summary
- No UI code changes needed — only the backend retry

## Technical details

The `call-transcribe` function now correctly:
- Requires `GOOGLE_SPEECH_API_KEY` (configured ✓)
- Uses `longrunningrecognize` with polling for audio files
- Supports diarization and speaker normalization
- Chains to `call-analyze` after successful transcription

