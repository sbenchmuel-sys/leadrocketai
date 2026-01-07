-- Add source_meeting_summary_id to link meeting_packs to zoom summaries
ALTER TABLE meeting_packs 
ADD COLUMN source_meeting_summary_id uuid REFERENCES meeting_summaries(id);