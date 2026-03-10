
-- Create winning_interactions table
CREATE TABLE public.winning_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  message_content text NOT NULL,
  channel text NOT NULL DEFAULT 'email',
  outcome_type text NOT NULL CHECK (outcome_type IN ('meeting_booked', 'positive_reply', 'deal_won')),
  promoted_to_kb boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.winning_interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view winning_interactions"
  ON public.winning_interactions FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can insert winning_interactions"
  ON public.winning_interactions FOR INSERT
  TO authenticated
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Service role full access on winning_interactions"
  ON public.winning_interactions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Indexes
CREATE INDEX idx_winning_interactions_lead_id ON public.winning_interactions(lead_id);
CREATE INDEX idx_winning_interactions_workspace_id ON public.winning_interactions(workspace_id);
CREATE INDEX idx_winning_interactions_promoted ON public.winning_interactions(promoted_to_kb) WHERE promoted_to_kb = false;
