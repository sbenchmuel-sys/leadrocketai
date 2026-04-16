
-- 1. style_examples: stores sent/liked/disliked messages for style learning
CREATE TABLE public.style_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'email',
  motion_type text NOT NULL DEFAULT 'outbound_cold',
  subject text,
  body_text text NOT NULL,
  feedback text NOT NULL DEFAULT 'sent',
  feedback_comment text,
  style_features_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.style_examples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own style examples"
  ON public.style_examples FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own style examples"
  ON public.style_examples FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() AND is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Users can delete their own style examples"
  ON public.style_examples FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access on style_examples"
  ON public.style_examples FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX idx_style_examples_user_channel_motion
  ON public.style_examples (user_id, channel, motion_type, created_at DESC);

-- 2. user_style_profiles: condensed style guide per user+channel+motion
CREATE TABLE public.user_style_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'email',
  motion_type text NOT NULL DEFAULT 'outbound_cold',
  profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  example_count int NOT NULL DEFAULT 0,
  last_synthesized_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, motion_type)
);

ALTER TABLE public.user_style_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own style profiles"
  ON public.user_style_profiles FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own style profiles"
  ON public.user_style_profiles FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access on user_style_profiles"
  ON public.user_style_profiles FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE TRIGGER update_user_style_profiles_updated_at
  BEFORE UPDATE ON public.user_style_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. user_style_directives: free-text voice anchor per user
CREATE TABLE public.user_style_directives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  directive_text text NOT NULL DEFAULT '',
  learning_paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_style_directives ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own style directives"
  ON public.user_style_directives FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can upsert their own style directives"
  ON public.user_style_directives FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own style directives"
  ON public.user_style_directives FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own style directives"
  ON public.user_style_directives FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access on user_style_directives"
  ON public.user_style_directives FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE TRIGGER update_user_style_directives_updated_at
  BEFORE UPDATE ON public.user_style_directives
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
