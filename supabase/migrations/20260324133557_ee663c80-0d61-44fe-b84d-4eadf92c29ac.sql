-- Step 1: Make workspace_id nullable so orphans can be quarantined
ALTER TABLE public.leads ALTER COLUMN workspace_id DROP NOT NULL;

-- Step 2: Null out the 3 orphaned leads whose owners have no workspace membership
UPDATE public.leads
SET workspace_id = NULL
WHERE owner_user_id NOT IN (
  SELECT DISTINCT user_id FROM public.workspace_members
);

-- Step 3: Add a view/query to identify quarantined leads for manual review
COMMENT ON COLUMN public.leads.workspace_id IS 'NULL means quarantined — owner has no workspace membership. Must be resolved before lead is usable.';