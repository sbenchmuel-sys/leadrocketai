## Apply migration: `20260503140000_lead_groups_and_partners.sql`

Phase 2 of the deals work — multi-stakeholder support (groups, champion lead, partners).

### What the migration does

1. **`lead_groups` table** — workspace-scoped stakeholder group with `champion_lead_id`, `group_name`, RLS via `is_workspace_member`, `updated_at` trigger.
2. **`leads.group_id`** — nullable FK to `lead_groups` (ON DELETE SET NULL) + partial index.
3. **`group_partners` table** — M:N between groups and existing `contacts`, with `role_note`, RLS gated through parent group's workspace.
4. **Integrity triggers**:
   - Deferred constraint trigger validating champion is a member of the group in the same workspace.
   - Cleanup trigger on `leads` UPDATE/DELETE: clears champion if removed, deletes empty groups.
5. **RPCs** (SECURITY DEFINER, granted to `authenticated`):
   - `create_lead_group_with_champion(lead_id, name?)` — atomic create + set champion, respects deferred constraint.
   - `set_lead_group_champion(group_id, new_champion_lead_id)`.

### Steps

1. Save the SQL verbatim to `supabase/migrations/20260503140000_lead_groups_and_partners.sql`.
2. Run it via the migration tool against the live database.
3. Lovable will regenerate `src/integrations/supabase/types.ts` automatically as part of applying the migration — no separate step needed.
4. Confirm to the user once applied. No frontend code changes in this PR — UI/wiring will come in subsequent work referencing these new tables/RPCs.

### Notes / safety

- All RLS policies use the existing `is_workspace_member` helper — consistent with project conventions.
- Deferred constraint trigger pattern is required so the RPC can insert group → set lead.group_id → set champion within one transaction.
- No data backfill; all existing leads remain `group_id = NULL` (solo).
- Idempotent guards used where appropriate (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`); the `CREATE TABLE` / `CREATE POLICY` / `CREATE TRIGGER` statements are not idempotent — assumes a fresh run.