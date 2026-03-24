
-- ============================================================
-- lead_timeline_items — Unified read-side ledger for lead comms
-- ============================================================

CREATE TABLE public.lead_timeline_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id),
  lead_id       uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  contact_id    uuid REFERENCES public.contacts(id),
  conversation_id uuid REFERENCES public.conversations(id),

  -- Classification
  channel       text NOT NULL DEFAULT 'email',          -- email, whatsapp, voice, meeting, system
  provider      text,                                    -- gmail, outlook, meta, twilio, zoom, manual
  direction     text,                                    -- inbound, outbound, null for meetings/notes
  event_type    text NOT NULL,                           -- email_inbound, email_outbound, whatsapp_inbound, whatsapp_outbound, phone_call, meeting, note, system_note

  -- Timing
  occurred_at   timestamptz NOT NULL DEFAULT now(),

  -- Source traceability
  source_table  text NOT NULL,                           -- interactions, call_sessions, meeting_summaries, messages
  source_id     text NOT NULL,                           -- UUID from source table (text for flexibility)

  -- Content
  snippet_text  text,                                    -- First ~500 chars of body or summary
  subject       text,
  
  -- Structured metadata
  status_json   jsonb DEFAULT '{}'::jsonb,               -- e.g. {hidden: true, ai_reply_worthy: true}
  metadata_json jsonb DEFAULT '{}'::jsonb,               -- e.g. {gmail_message_id: "...", call_duration_sec: 120}

  -- Deduplication
  dedupe_key    text NOT NULL,                           -- Unique per lead+event, used for upsert

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_lead_timeline_dedupe UNIQUE (lead_id, dedupe_key)
);

-- Indexes
CREATE INDEX idx_lti_lead_occurred ON public.lead_timeline_items (lead_id, occurred_at DESC);
CREATE INDEX idx_lti_workspace ON public.lead_timeline_items (workspace_id);
CREATE INDEX idx_lti_source ON public.lead_timeline_items (source_table, source_id);
CREATE INDEX idx_lti_channel ON public.lead_timeline_items (lead_id, channel);

-- RLS
ALTER TABLE public.lead_timeline_items ENABLE ROW LEVEL SECURITY;

-- Workspace members can read timeline items
CREATE POLICY "Workspace members can view timeline items"
  ON public.lead_timeline_items
  FOR SELECT
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

-- Service role full access (for projectors)
CREATE POLICY "Service role full access on lead_timeline_items"
  ON public.lead_timeline_items
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Lead owners can hide/update status
CREATE POLICY "Lead owners can update timeline items"
  ON public.lead_timeline_items
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads
      WHERE leads.id = lead_timeline_items.lead_id
      AND leads.owner_user_id = auth.uid()
    )
  );

-- updated_at trigger
CREATE TRIGGER trg_lti_updated_at
  BEFORE UPDATE ON public.lead_timeline_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for live timeline updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.lead_timeline_items;
