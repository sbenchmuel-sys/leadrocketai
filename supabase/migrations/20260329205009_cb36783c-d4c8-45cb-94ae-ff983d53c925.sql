
-- Phase 1A: Lead Context Items table + raw_import_json on leads

-- 1. Add raw_import_json column to leads table (preserves verbatim CSV/Excel data)
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS raw_import_json jsonb DEFAULT NULL;

-- 2. Create lead_context_items table
CREATE TABLE public.lead_context_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  
  -- Classification
  category text NOT NULL DEFAULT 'imported_note',
  -- Values: 'historical_fact', 'relationship_history', 'commercial_signal', 
  --         'inferred_hypothesis', 'caution', 'imported_note'
  -- 'imported_note' is the safe default for ambiguous free-text

  content_type text NOT NULL DEFAULT 'general',
  -- Values: 'prior_contact', 'product_owned', 'known_objection', 'competitor_intel',
  --         'budget_info', 'decision_process', 'personal_preference', 'do_not_mention',
  --         'prior_rep_notes', 'next_step', 'general'
  
  -- Content
  content_text text NOT NULL,
  original_snippet text,

  -- Provenance
  source_type text NOT NULL DEFAULT 'csv_import',
  -- Values: 'csv_import', 'manual_note', 'uploaded_document', 'ai_extraction', 'rep_entry'
  source_column_name text,
  confidence real,
  author_name text,
  context_date timestamptz,
  
  -- Linking
  parent_item_id uuid REFERENCES public.lead_context_items(id) ON DELETE SET NULL,
  -- Used when AI-derived items link back to their source item

  -- State
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_lead_context_items_lead ON public.lead_context_items(lead_id) WHERE is_active = true;
CREATE INDEX idx_lead_context_items_workspace ON public.lead_context_items(workspace_id);
CREATE INDEX idx_lead_context_items_category ON public.lead_context_items(lead_id, category) WHERE is_active = true;
-- Dedupe index: prevent duplicate imports of same content from same column
CREATE UNIQUE INDEX idx_lead_context_items_dedupe 
  ON public.lead_context_items(lead_id, source_type, source_column_name, md5(content_text))
  WHERE source_type = 'csv_import' AND source_column_name IS NOT NULL;

-- RLS
ALTER TABLE public.lead_context_items ENABLE ROW LEVEL SECURITY;

-- Workspace members can view
CREATE POLICY "Workspace members can view lead context items"
  ON public.lead_context_items FOR SELECT
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

-- Lead owners can insert
CREATE POLICY "Lead owners can insert lead context items"
  ON public.lead_context_items FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.leads
      WHERE leads.id = lead_context_items.lead_id
      AND leads.owner_user_id = auth.uid()
    )
  );

-- Lead owners can update (for deactivation, editing)
CREATE POLICY "Lead owners can update lead context items"
  ON public.lead_context_items FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads
      WHERE leads.id = lead_context_items.lead_id
      AND leads.owner_user_id = auth.uid()
    )
  );

-- Lead owners can delete
CREATE POLICY "Lead owners can delete lead context items"
  ON public.lead_context_items FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads
      WHERE leads.id = lead_context_items.lead_id
      AND leads.owner_user_id = auth.uid()
    )
  );

-- Service role full access
CREATE POLICY "Service role full access on lead_context_items"
  ON public.lead_context_items FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Updated_at trigger
CREATE TRIGGER update_lead_context_items_updated_at
  BEFORE UPDATE ON public.lead_context_items
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Invalidate lead_context_cache when context items change
CREATE TRIGGER trg_invalidate_cache_on_context_item
  AFTER INSERT OR UPDATE OR DELETE ON public.lead_context_items
  FOR EACH ROW
  EXECUTE FUNCTION invalidate_lead_context_cache();
