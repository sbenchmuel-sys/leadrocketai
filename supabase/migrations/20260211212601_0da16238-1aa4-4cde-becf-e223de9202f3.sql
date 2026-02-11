
-- Precomputed manager analytics table
-- Stores aggregated, non-PII metrics per rep per workspace
CREATE TABLE public.manager_views (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rep_user_id uuid NOT NULL,
  computed_at timestamp with time zone NOT NULL DEFAULT now(),

  -- Response time metrics
  avg_response_time_minutes double precision DEFAULT 0,
  median_response_time_minutes double precision DEFAULT 0,
  
  -- Needs-reply count
  needs_reply_count integer DEFAULT 0,
  
  -- Deal stage distribution (jsonb: {"new": 3, "engaged": 5, ...})
  stage_distribution jsonb DEFAULT '{}'::jsonb,
  
  -- Objection frequency (jsonb: {"pricing": 4, "timeline": 2, ...})
  objection_frequency jsonb DEFAULT '{}'::jsonb,
  
  -- Ghosting risk alerts
  high_ghost_risk_count integer DEFAULT 0,
  medium_ghost_risk_count integer DEFAULT 0,
  ghost_risk_contacts jsonb DEFAULT '[]'::jsonb,
  
  -- Channel effectiveness
  channel_metrics jsonb DEFAULT '{}'::jsonb,
  
  -- Totals
  total_conversations integer DEFAULT 0,
  total_messages_sent integer DEFAULT 0,
  total_messages_received integer DEFAULT 0,
  active_conversations integer DEFAULT 0,
  
  -- Summary stats
  sentiment_distribution jsonb DEFAULT '{}'::jsonb,
  urgency_distribution jsonb DEFAULT '{}'::jsonb,
  top_topics jsonb DEFAULT '[]'::jsonb,

  created_at timestamp with time zone NOT NULL DEFAULT now(),
  
  UNIQUE(workspace_id, rep_user_id)
);

-- Enable RLS
ALTER TABLE public.manager_views ENABLE ROW LEVEL SECURITY;

-- Only workspace admins and managers can view
CREATE POLICY "Admins and managers can view manager_views"
  ON public.manager_views FOR SELECT
  USING (
    is_workspace_member(workspace_id, auth.uid()) 
    AND get_workspace_role(workspace_id, auth.uid()) IN ('admin', 'manager')
  );

-- No direct insert/update/delete from clients - only via service role
-- (the compute function uses service role key)

-- Index for fast lookups
CREATE INDEX idx_manager_views_workspace ON public.manager_views(workspace_id);
CREATE INDEX idx_manager_views_computed ON public.manager_views(computed_at);
