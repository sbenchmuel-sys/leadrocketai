-- Delete orphan mail_accounts rows (no user_id and no tokens) — leftovers from aborted OAuth flows.
DELETE FROM public.mail_accounts
WHERE user_id IS NULL
  AND access_token IS NULL
  AND refresh_token IS NULL;

-- For any workspace left without a default mail_account, promote the oldest connected one.
WITH workspaces_missing_default AS (
  SELECT workspace_id
  FROM public.mail_accounts
  WHERE status = 'connected'
  GROUP BY workspace_id
  HAVING bool_or(is_default) = false
),
promote AS (
  SELECT DISTINCT ON (ma.workspace_id) ma.id
  FROM public.mail_accounts ma
  JOIN workspaces_missing_default w ON w.workspace_id = ma.workspace_id
  WHERE ma.status = 'connected'
  ORDER BY ma.workspace_id, ma.created_at ASC
)
UPDATE public.mail_accounts
SET is_default = true
WHERE id IN (SELECT id FROM promote);