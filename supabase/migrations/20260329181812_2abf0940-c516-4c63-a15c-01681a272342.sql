
-- Structured offer registry for commercial recommendation routing
CREATE TABLE public.offer_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  offer_key text NOT NULL,
  offer_name text NOT NULL,
  offer_category text NOT NULL DEFAULT 'general',
  customer_facing_summary text NOT NULL,
  internal_notes text,
  link_url text,
  cta_type text NOT NULL DEFAULT 'soft_offer',
  allowed_channels text[] NOT NULL DEFAULT ARRAY['email', 'whatsapp', 'linkedin'],
  allowed_stages text[] NOT NULL DEFAULT ARRAY['contacted', 'engaged', 'post_meeting', 'negotiation'],
  trigger_tags text[] NOT NULL DEFAULT '{}',
  trigger_phrases text[] NOT NULL DEFAULT '{}',
  related_objections text[] NOT NULL DEFAULT '{}',
  related_segments text[] NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, offer_key)
);

-- Enable RLS
ALTER TABLE public.offer_registry ENABLE ROW LEVEL SECURITY;

-- Workspace members can view offers
CREATE POLICY "Workspace members can view offers"
  ON public.offer_registry FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

-- Workspace admins can manage offers
CREATE POLICY "Workspace admins can manage offers"
  ON public.offer_registry FOR ALL TO authenticated
  USING (is_workspace_admin(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_admin(workspace_id, auth.uid()));

-- Service role full access
CREATE POLICY "Service role full access on offer_registry"
  ON public.offer_registry FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Updated_at trigger
CREATE TRIGGER update_offer_registry_updated_at
  BEFORE UPDATE ON public.offer_registry
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
