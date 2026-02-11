
-- =============================================
-- 1. ENUMS
-- =============================================
CREATE TYPE public.workspace_role AS ENUM ('admin', 'manager', 'rep');
CREATE TYPE public.contact_status AS ENUM ('unclassified', 'lead', 'customer', 'blocked');
CREATE TYPE public.message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE public.identity_type AS ENUM ('phone', 'email', 'whatsapp');
CREATE TYPE public.integration_type AS ENUM ('gmail', 'whatsapp');

-- =============================================
-- 2. WORKSPACES
-- =============================================
CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  billing_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER update_workspaces_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- 3. WORKSPACE MEMBERS
-- =============================================
CREATE TABLE public.workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role workspace_role NOT NULL DEFAULT 'rep',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_workspace_members_user ON public.workspace_members(user_id);
CREATE INDEX idx_workspace_members_workspace ON public.workspace_members(workspace_id);

-- =============================================
-- 4. SECURITY DEFINER: workspace role lookup
-- =============================================
CREATE OR REPLACE FUNCTION public.get_workspace_role(_workspace_id uuid, _user_id uuid)
RETURNS workspace_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = _workspace_id AND user_id = _user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_admin(_workspace_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = _workspace_id AND user_id = _user_id AND role = 'admin'
  );
$$;

-- =============================================
-- 5. INTEGRATIONS (per-rep connections)
-- =============================================
CREATE TABLE public.integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type integration_type NOT NULL,
  provider_account_id text, -- e.g. phone_number_id or gmail email
  credentials_encrypted text, -- AES-256-GCM encrypted JSON blob
  webhook_verify_token text,
  is_active boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, user_id, type)
);
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER update_integrations_updated_at
  BEFORE UPDATE ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- 6. CONTACTS
-- =============================================
CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  display_name text,
  status contact_status NOT NULL DEFAULT 'unclassified',
  assigned_rep_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  company text,
  notes text,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_contacts_workspace ON public.contacts(workspace_id);
CREATE INDEX idx_contacts_last_activity ON public.contacts(workspace_id, last_activity_at DESC);
CREATE INDEX idx_contacts_assigned_rep ON public.contacts(assigned_rep_user_id);

CREATE TRIGGER update_contacts_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- 7. CONTACT IDENTITIES (phone / email)
-- =============================================
CREATE TABLE public.contact_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  type identity_type NOT NULL,
  value text NOT NULL, -- E.164 phone or email address
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, type, value) -- unique per workspace
);
ALTER TABLE public.contact_identities ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_identity_phone ON public.contact_identities(workspace_id, value) WHERE type = 'phone';
CREATE INDEX idx_identity_email ON public.contact_identities(workspace_id, value) WHERE type = 'email';
CREATE INDEX idx_identity_contact ON public.contact_identities(contact_id);

-- =============================================
-- 8. CONVERSATIONS
-- =============================================
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id), -- the rep
  integration_id uuid REFERENCES public.integrations(id) ON DELETE SET NULL,
  channel integration_type NOT NULL DEFAULT 'whatsapp',
  provider_thread_id text, -- external thread/chat ID
  status text NOT NULL DEFAULT 'active',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  message_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_conversations_owner ON public.conversations(owner_user_id);
CREATE INDEX idx_conversations_workspace ON public.conversations(workspace_id);
CREATE INDEX idx_conversations_last_msg ON public.conversations(workspace_id, last_message_at DESC);
CREATE INDEX idx_conversations_contact ON public.conversations(contact_id);

CREATE TRIGGER update_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- 9. MESSAGES (encrypted body, 72h TTL)
-- =============================================
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  direction message_direction NOT NULL,
  body_ciphertext text, -- AES-256-GCM encrypted, NULL after expiry cleanup
  provider_message_id text, -- wamid or gmail message id
  sender_identity_id uuid REFERENCES public.contact_identities(id),
  media_type text, -- 'text','image','document','audio','video'
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, provider_message_id) -- idempotent ingestion
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_messages_conversation ON public.messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_expires ON public.messages(expires_at) WHERE body_ciphertext IS NOT NULL;
CREATE INDEX idx_messages_provider ON public.messages(workspace_id, provider_message_id);

-- =============================================
-- 10. CONVERSATION ANALYSIS (permanent)
-- =============================================
CREATE TABLE public.conversation_analysis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  summary_text text,
  sentiment text, -- 'positive','neutral','negative','mixed'
  topics text[],
  extracted_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  embedding vector(768),
  model_used text,
  message_window_start timestamptz,
  message_window_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.conversation_analysis ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_analysis_conversation ON public.conversation_analysis(conversation_id);
CREATE INDEX idx_analysis_workspace ON public.conversation_analysis(workspace_id);
CREATE INDEX idx_analysis_contact ON public.conversation_analysis(contact_id);

-- =============================================
-- 11. MANAGER VIEW (no message body access)
-- =============================================
CREATE VIEW public.manager_conversation_metrics
WITH (security_invoker = on) AS
SELECT
  c.id AS conversation_id,
  c.workspace_id,
  c.contact_id,
  c.owner_user_id,
  c.channel,
  c.status,
  c.last_message_at,
  c.message_count,
  ct.display_name AS contact_name,
  ct.status AS contact_status,
  ct.company AS contact_company,
  ca.summary_text AS latest_summary,
  ca.sentiment AS latest_sentiment,
  ca.topics AS latest_topics,
  ca.extracted_features AS latest_features
FROM public.conversations c
JOIN public.contacts ct ON ct.id = c.contact_id
LEFT JOIN LATERAL (
  SELECT * FROM public.conversation_analysis
  WHERE conversation_id = c.id
  ORDER BY created_at DESC LIMIT 1
) ca ON true;

-- =============================================
-- 12. RLS POLICIES
-- =============================================

-- WORKSPACES: members can read, admins can update
CREATE POLICY "Members can view their workspaces"
  ON public.workspaces FOR SELECT
  USING (public.is_workspace_member(id, auth.uid()));

CREATE POLICY "Admins can update their workspace"
  ON public.workspaces FOR UPDATE
  USING (public.is_workspace_admin(id, auth.uid()));

CREATE POLICY "Authenticated users can create workspaces"
  ON public.workspaces FOR INSERT
  WITH CHECK (true);

-- WORKSPACE_MEMBERS: members see co-members, admins manage
CREATE POLICY "Members can view workspace members"
  ON public.workspace_members FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins can insert workspace members"
  ON public.workspace_members FOR INSERT
  WITH CHECK (public.is_workspace_admin(workspace_id, auth.uid())
    OR NOT EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = workspace_members.workspace_id));

CREATE POLICY "Admins can update workspace members"
  ON public.workspace_members FOR UPDATE
  USING (public.is_workspace_admin(workspace_id, auth.uid()));

CREATE POLICY "Admins can delete workspace members"
  ON public.workspace_members FOR DELETE
  USING (public.is_workspace_admin(workspace_id, auth.uid()));

-- INTEGRATIONS: own connections only
CREATE POLICY "Users can view their own integrations"
  ON public.integrations FOR SELECT
  USING (user_id = auth.uid() AND public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Users can create their own integrations"
  ON public.integrations FOR INSERT
  WITH CHECK (user_id = auth.uid() AND public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Users can update their own integrations"
  ON public.integrations FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own integrations"
  ON public.integrations FOR DELETE
  USING (user_id = auth.uid());

-- CONTACTS: rep sees assigned, admin sees all, manager sees all
CREATE POLICY "Workspace members can view contacts"
  ON public.contacts FOR SELECT
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (
      public.get_workspace_role(workspace_id, auth.uid()) IN ('admin', 'manager')
      OR assigned_rep_user_id = auth.uid()
      OR assigned_rep_user_id IS NULL
    )
  );

CREATE POLICY "Members can create contacts"
  ON public.contacts FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins and assigned reps can update contacts"
  ON public.contacts FOR UPDATE
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (
      public.get_workspace_role(workspace_id, auth.uid()) = 'admin'
      OR assigned_rep_user_id = auth.uid()
    )
  );

CREATE POLICY "Admins can delete contacts"
  ON public.contacts FOR DELETE
  USING (public.is_workspace_admin(workspace_id, auth.uid()));

-- CONTACT_IDENTITIES: same as contacts
CREATE POLICY "Workspace members can view identities"
  ON public.contact_identities FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Members can create identities"
  ON public.contact_identities FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Members can update identities"
  ON public.contact_identities FOR UPDATE
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- CONVERSATIONS: rep sees own, admin sees all, manager sees all (via view only for content)
CREATE POLICY "Rep sees own conversations, admin/manager see all"
  ON public.conversations FOR SELECT
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (
      public.get_workspace_role(workspace_id, auth.uid()) IN ('admin', 'manager')
      OR owner_user_id = auth.uid()
    )
  );

CREATE POLICY "Rep can create conversations"
  ON public.conversations FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() AND public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Rep and admin can update conversations"
  ON public.conversations FOR UPDATE
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (
      public.get_workspace_role(workspace_id, auth.uid()) = 'admin'
      OR owner_user_id = auth.uid()
    )
  );

-- MESSAGES: rep sees own conversation messages, admin sees all, MANAGER DENIED
CREATE POLICY "Rep and admin can view messages"
  ON public.messages FOR SELECT
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND public.get_workspace_role(workspace_id, auth.uid()) != 'manager'
    AND (
      public.get_workspace_role(workspace_id, auth.uid()) = 'admin'
      OR EXISTS (
        SELECT 1 FROM public.conversations
        WHERE conversations.id = messages.conversation_id
        AND conversations.owner_user_id = auth.uid()
      )
    )
  );

CREATE POLICY "System can insert messages"
  ON public.messages FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

-- CONVERSATION_ANALYSIS: rep sees own, admin/manager see all
CREATE POLICY "Members can view analysis"
  ON public.conversation_analysis FOR SELECT
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (
      public.get_workspace_role(workspace_id, auth.uid()) IN ('admin', 'manager')
      OR EXISTS (
        SELECT 1 FROM public.conversations
        WHERE conversations.id = conversation_analysis.conversation_id
        AND conversations.owner_user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Members can create analysis"
  ON public.conversation_analysis FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));
