# BULK_OPS_INVENTORY.md — existing bulk-operation surfaces

Date: 2026-05-20. Read-only audit; no code changed.
Companion to [AUDIT.md](AUDIT.md) and [EDGE_CASES.md](EDGE_CASES.md).

DrivePilot has bulk operations in **three surfaces**: the Dashboard's
`LeadTable`, the legacy `/app/leads` page, and the `PendingLeadsTab` of
that same page. Inbox has none. Lead detail has none. There is no bulk
export, no bulk tag/categorize, no bulk owner-reassignment, and no
generic "bulk archive". All multi-select state machinery uses the same
shape (`useState<Set<string>>`).

---

## Bulk operations — per operation

### B1. Bulk enable automation

**1. UI.** [src/components/dashboard/BulkAutomationDialog.tsx](src/components/dashboard/BulkAutomationDialog.tsx) (316 lines, last touched 2026-05-03). Trigger: in-row sticky-ish action strip inside `LeadTable.tsx` ([dashboard/LeadTable.tsx:702–807](src/components/dashboard/LeadTable.tsx:702)) → "Enable Automation" button ([line 798–807](src/components/dashboard/LeadTable.tsx:798)) → opens `<BulkAutomationDialog>` ([line 1372–1380](src/components/dashboard/LeadTable.tsx:1372)). Selection state is a `Set<string>` named `selectedLeads` ([LeadTable.tsx:294](src/components/dashboard/LeadTable.tsx:294)). Dialog body shows a per-lead checklist with **per-lead eligibility flags** (`has_replied`, `not_eligible_motion`, `closed`, `already_active`) computed by `categorizeLead()` ([BulkAutomationDialog.tsx:52–71](src/components/dashboard/BulkAutomationDialog.tsx:52)). Ineligible rows are pre-unchecked and disabled. Confirmation is the dialog itself; no separate undo.

**2. What it does.** Sets `automation_mode='full_auto'`, computes per-lead `next_action_key` / `eligible_at` / `next_action_label` from the motion (outbound_prospecting → `send_pre_1/2`, inbound_response → 3-step, nurture → `nurture_<N>` with cadence-driven interval), and stamps optional `action_instructions`. **Not reversible** — the rep has to manually pause each lead afterward.

**3. Backend.** Bespoke per-lead `supabase.from("leads").update(...)` calls run via `Promise.all` ([BulkAutomationDialog.tsx:194–202](src/components/dashboard/BulkAutomationDialog.tsx:194)). No shared helper; the entire field set comes from local `computeAutomationFields()` ([BulkAutomationDialog.tsx:73–134](src/components/dashboard/BulkAutomationDialog.tsx:73)) which calls `getMotionIntervals`, `getNurtureCadenceDays`, `calculateEligibleAt` from [src/lib/cadenceSettingsTypes.ts](src/lib/cadenceSettingsTypes.ts). Note: this writes the consent gate (`automation_mode`) — explicitly per the executor gate documented in [_shared/syncEngine.ts:602–625](supabase/functions/_shared/syncEngine.ts:602).

**4. Lead-state guardrails.** Filters out:
- `last_inbound_at` set AND `motion !== 'nurture'` → flagged `has_replied`.
- `stage in ('closed_won','closed_lost')` → flagged `closed`.
- `motion` not in {`outbound_prospecting`, `inbound_response`, `nurture`} → flagged `not_eligible_motion`.
- `eligible_at != null && needs_action` → flagged `already_active`.
Flagged rows can be re-checked manually but ineligibility is intentional.

**5. Reusability.**
- Dialog itself: **lifts cleanly** as-is. Inputs are `selectedLeads: EnrichedLead[]` + open state. Only coupling is the `EnrichedLead` shape — a new `/app/leads` redesign that produces the same type drops it in.
- Backend logic: also fine to reuse, but the per-lead `Promise.all` of `supabase.from("leads").update(...)` is naive. For N > ~50 leads it's a write-amplification problem. Worth extracting into a `bulkEnableAutomation(leads)` helper in `supabaseQueries.ts` that batches via `.in('id', …)` per shared field set — but the per-lead nature of `next_action_key`/`eligible_at` makes a single `.in()` impossible. So really: keep per-lead writes but add concurrency cap.

---

### B2. Bulk move to nurture

**1. UI.** Inline `AlertDialog` inside [LeadTable.tsx:809–887](src/components/dashboard/LeadTable.tsx:809). Trigger: "Move to Nurture" button in the same action strip as B1 ([line 811–819](src/components/dashboard/LeadTable.tsx:811)). Confirmation copy: "Each selected lead will be switched to the biweekly nurture cadence in review mode." Not undoable.

**2. What it does.** Per selected lead: `motion='nurture'`, `nurture_status='active'`, `nurture_mode='review'`, `nurture_cadence='biweekly'`, computes `eligible_at = now + 14 days at 09:30`, sets `next_action_key='nurture_1'`, `action_reason_code='NURTURE_DUE'`. **Not reversible** without the per-lead nurture-off control on Lead Detail.

**3. Backend.** Inline `supabase.from("leads").update(...)` per id via `Promise.all` ([LeadTable.tsx:848–865](src/components/dashboard/LeadTable.tsx:848)). No shared helper. Imports `getNurtureCadenceDays` dynamically.

**4. Lead-state guardrails.** None — applies to all selected leads regardless of stage, motion or existing automation. **Worth flagging.** A lead with active outbound automation gets clobbered into nurture with no warning.

**5. Reusability.**
- UI: lives inline inside `LeadTable.tsx`'s 1400-line render tree. Not currently a component — would need extraction into a `<BulkNurtureDialog>` alongside `<BulkAutomationDialog>` to lift.
- Backend: trivially reusable once extracted; but should grow a `categorizeLead`-style flag set similar to B1 (e.g. "currently in active sequence" → warn).

---

### B3. Bulk stage change

**1. UI.** Select dropdown in the same `LeadTable` action strip ([LeadTable.tsx:707–721](src/components/dashboard/LeadTable.tsx:707)) labelled "Move to stage...". Choosing a stage fires immediately — **no confirmation step**, no undo.

**2. What it does.** Updates `leads.stage` and `leads.last_activity_at` for every selected lead.

**3. Backend.** Shared helper [bulkUpdateLeadStage(leadIds, stage)](src/lib/supabaseQueries.ts) at [src/lib/supabaseQueries.ts:1889–1901](src/lib/supabaseQueries.ts:1889). Uses a single `.in('id', leadIds)` — proper batched write, only one of the bulk ops that does this.

**4. Lead-state guardrails.** None.

**5. Reusability.**
- UI: tiny piece (1 Select + 1 handler), easy to lift but currently inline.
- Backend: `bulkUpdateLeadStage` is the cleanest reusable helper in the codebase. Use it as the template for any new bulk RPC.

---

### B4. Bulk source change

**1. UI.** Select dropdown next to B3 ([LeadTable.tsx:723–754](src/components/dashboard/LeadTable.tsx:723)) labelled "Change source...". No confirmation, no undo.

**2. What it does.** Updates `source_type` per lead.

**3. Backend.** Loops `updateSourceFromTable(id, key)` per id ([LeadTable.tsx:728–732](src/components/dashboard/LeadTable.tsx:728)) — bespoke per-lead. `updateSourceFromTable` is local to `LeadTable.tsx` (defined inline or in a helper near the top — confirmed there's no shared `lib/` helper named that).

**4. Lead-state guardrails.** None.

**5. Reusability.**
- UI: trivial.
- Backend: not reusable as-is. Same pattern as B1 — per-lead write. Could batch into a single `.in()` if the source-change side effects are minimal. Worth extracting.

---

### B5. Bulk delete — Dashboard variant

**1. UI.** Destructive button + `AlertDialog` ([LeadTable.tsx:756–796](src/components/dashboard/LeadTable.tsx:756)). Copy: "All associated interactions, drafts, and meeting packs will also be deleted." **Confirmed via dialog. Not undoable.**

**2. What it does.** Calls `deleteLead(id)` per selected id via `Promise.all` ([LeadTable.tsx:425](src/components/dashboard/LeadTable.tsx:425)). Cascade deletes interactions, drafts, meeting_packs, lead_timeline_items (via FK ON DELETE CASCADE).

**3. Backend.** [deleteLead(leadId)](src/lib/supabaseQueries.ts) at [src/lib/supabaseQueries.ts:271–281](src/lib/supabaseQueries.ts:271) — single-row delete. No `bulkDeleteLeads()` helper exists. The bulk wrapper is `Promise.all(ids.map(deleteLead))`.

**4. Guardrails.** None at the DB level — RLS enforces ownership; nothing prevents accidental destruction of leads with active automation.

**5. Reusability.**
- UI: lifts cleanly but inline.
- Backend: a `bulkDeleteLeads(leadIds)` shared helper using `.delete().in('id', ids)` would be a one-function-extraction win.

---

### B6. Bulk delete — `/app/leads` page variant

**1. UI.** Header bar of `/app/leads`: [src/pages/Leads.tsx:392–413](src/pages/Leads.tsx:392). Destructive button → `AlertDialog`. Selection state: `selectedIds: Set<string>` ([Leads.tsx:55](src/pages/Leads.tsx:55)) — same shape as LeadTable but separate state. Per-row checkboxes ([Leads.tsx:478–482](src/pages/Leads.tsx:478)), select-all in table head ([line 459–463](src/pages/Leads.tsx:459)).

**2 / 3 / 4 / 5.** Identical to B5 in everything but UI location — `handleBulkDelete` at [Leads.tsx:98–112](src/pages/Leads.tsx:98) calls the same `Promise.all(deleteLead)` pattern. Two parallel implementations of bulk delete in two different surfaces, no shared component or helper.

---

### B7. Bulk mailbox sync (Gmail / Outlook)

**1. UI.** Same `/app/leads` header action strip as B6: [Leads.tsx:394–403](src/pages/Leads.tsx:394). "Sync Gmail/Outlook (N)" button. No confirmation. Visible reconnect alert ([Leads.tsx:415–445](src/pages/Leads.tsx:415)) if mail isn't connected.

**2. What it does.** For every selected lead, runs an inbound mail fetch via the bulk-sync edge function. Updates `interactions`, `lead_timeline_items`, and computed lead state via the standard sync pipeline.

**3. Backend.** Batches ids by 15 and invokes either `gmail-bulk-sync` or `outlook-bulk-sync` ([Leads.tsx:167–203](src/pages/Leads.tsx:167)) — see [supabase/functions/gmail-bulk-sync/index.ts](supabase/functions/gmail-bulk-sync/index.ts) and [supabase/functions/outlook-bulk-sync/index.ts](supabase/functions/outlook-bulk-sync/index.ts). Body shape: `{ leadIds: string[] }`.

**4. Guardrails.** Requires `isMailConnected`. Handles `invalid_grant`, `revoked`, `refresh token`, `token expired` → surfaces a reconnect prompt. Per-batch error tolerance (continues remaining batches).

**5. Reusability.**
- UI: the toast-driven status pattern + reconnect alert are the only bulk-op UI that handles auth failure cleanly. Worth reusing as a template.
- Backend: `gmail-bulk-sync` / `outlook-bulk-sync` already batch internally — they DO support `leadIds: string[]` as input. Reusable from any new surface.

---

### B8. Bulk CSV import

**1. UI.** [src/components/leads/LeadImportDialog.tsx](src/components/leads/LeadImportDialog.tsx). Triggered from `/app/leads` header at [Leads.tsx:293](src/pages/Leads.tsx:293). Wizard: upload → source selection → confirm. Auto-detects column structure. Dedupes within-file by email AND against existing workspace leads ([LeadImportDialog.tsx:89–139](src/components/leads/LeadImportDialog.tsx:89)).

**2. What it does.** Parses CSV/XLSX/JSON via [src/lib/parseLeadFile.ts](src/lib/parseLeadFile.ts) `parseLeadFile()` ([parseLeadFile.ts:557](src/lib/parseLeadFile.ts:557)), inserts new leads with source preset metadata, optionally seeds intro send. Also called from [src/components/onboarding/CreateLeadStep.tsx](src/components/onboarding/CreateLeadStep.tsx).

**3. Backend.** Direct `supabase.from("leads").insert(...)` batched after dedup. Uses client-generated UUIDs to know IDs pre-insert ([LeadImportDialog.tsx:183](src/components/leads/LeadImportDialog.tsx:183)). Companion: `extractLeadContextItems()` populates `lead_context_items` from the same parse.

**4. Guardrails.** Two-stage dedup (within-file + vs. workspace), email validation, stage validation against `validStages` allowlist.

**5. Reusability.**
- UI: self-contained, lifts as-is — already used by two callers.
- Backend: `parseLeadFile()` is the only piece worth reusing standalone; insert logic is tangled in the dialog's `handleImport`.

---

### B9. Bulk approve lead candidates

**1. UI.** [src/components/leads/PendingLeadsTab.tsx](src/components/leads/PendingLeadsTab.tsx) (last touched 2026-05-12). Selection state: `selected: Set<string>` ([PendingLeadsTab.tsx:214](src/components/leads/PendingLeadsTab.tsx:214)). Per-row checkbox, "Select all" in header ([line 506–512](src/components/leads/PendingLeadsTab.tsx:506)). **Sticky action bar** at [line 542–566](src/components/leads/PendingLeadsTab.tsx:542) — actually `sticky top-0 z-10`, the only true sticky bar in the bulk-ops codebase. Buttons: Approve all / Dismiss all / Dismiss domain forever / Cancel. Confirmation if >5 candidates ([line 402–408](src/components/leads/PendingLeadsTab.tsx:402)).

**2. What it does.** For each selected `lead_candidates` row: creates a `leads` row via `createLeadFromCandidate()` (defined locally near [line 200](src/components/leads/PendingLeadsTab.tsx:200)), then sets `lead_candidates.status='approved'` with `resolved_lead_id`. Optimistic local removal with rollback snapshot on failure ([line 369–395](src/components/leads/PendingLeadsTab.tsx:369)). Retry toast on partial failure. Group-as-one mode at [line 470–495](src/components/leads/PendingLeadsTab.tsx:470) creates one lead with N stakeholder contacts.

**3. Backend.** Per-candidate `createLeadFromCandidate` (inline) + `supabase.from("lead_candidates").update({status:'approved',...}).eq("id", c.id)`. Group-mode batches the candidate update via `.in('id', ids)` ([line 482–485](src/components/leads/PendingLeadsTab.tsx:482)). Real-time subscription on `lead_candidates` keeps the list fresh ([line 242–249](src/components/leads/PendingLeadsTab.tsx:242)).

**4. Guardrails.** >5 → confirmation step. Per-candidate error tolerance with rollback. The `removeLocal` helper keeps selection state consistent.

**5. Reusability.**
- UI: **the sticky action bar pattern is the one to lift verbatim** for a new `/app/leads` redesign — best UX of the existing bulk surfaces, including optimistic updates + retry toasts.
- Backend: `createLeadFromCandidate` is candidate-shaped, not lead-shaped, so not directly reusable for general bulk-lead operations. The candidate-update side IS reusable.

---

### B10. Bulk dismiss candidates

**1. UI.** Same sticky bar as B9 — "Dismiss all" button ([PendingLeadsTab.tsx:548–550](src/components/leads/PendingLeadsTab.tsx:548)). Optimistic with snapshot rollback. Retry toast.

**2. What it does.** Updates `lead_candidates.status='dismissed'` for selected ids. "Won't suggest again for 90 days." per single-row toast copy.

**3. Backend.** Single `.update({status:'dismissed', resolved_at}).in('id', ids)` ([PendingLeadsTab.tsx:415–420](src/components/leads/PendingLeadsTab.tsx:415)).

**4. Guardrails.** None — applies to whatever's selected.

**5. Reusability.** Clean `.in()` batched write. The optimistic-with-rollback pattern is good — easy to abstract for any "status update many" operation.

---

### B11. Bulk "dismiss domain forever"

**1. UI.** "Dismiss domain forever" button in the sticky bar ([PendingLeadsTab.tsx:551–561](src/components/leads/PendingLeadsTab.tsx:551)) → confirmation `AlertDialog`. Extracts unique domains from selection.

**2. What it does.** Upserts rows into `workspace_dismissed_domains` ([PendingLeadsTab.tsx:442–445](src/components/leads/PendingLeadsTab.tsx:442)) and ALSO dismisses all currently-pending candidates from those domains in one `.in()` update ([line 452–457](src/components/leads/PendingLeadsTab.tsx:452)). Two-table mutation per click.

**3. Backend.** Direct supabase calls — no shared helper. The dismissed-domain list is editable separately via [DismissedListsDialog.tsx](src/components/leads/DismissedListsDialog.tsx).

**4. Guardrails.** Confirmation dialog. The dismiss-list editor has per-row Undo toasts ([DismissedListsDialog.tsx:128–152](src/components/leads/DismissedListsDialog.tsx:128)) — the only **per-row undo** anywhere in the bulk-ops codebase.

**5. Reusability.** Specific to candidate domains, but the **two-table optimistic mutation pattern** (upsert allowlist + bulk-update affected rows) is worth porting if we ever build "Always nurture domain X" or similar.

---

### B12. Bulk approve as one lead (group-by-domain)

**1. UI.** Per-group buttons in the grouped view ([PendingLeadsTab.tsx:582–589](src/components/leads/PendingLeadsTab.tsx:582)): "Approve as 1 lead with N contacts" / "Approve as N separate leads". Activated by the "Group by company" Switch in the header ([line 514–517](src/components/leads/PendingLeadsTab.tsx:514)).

**2. What it does.** Creates a single lead from the first candidate (champion), then writes a stakeholder note containing the other emails. Marks all candidates in the group as approved.

**3. Backend.** `approveGroupAsOne` at [PendingLeadsTab.tsx:470–495](src/components/leads/PendingLeadsTab.tsx:470). Single `createLeadFromCandidate` + batched `.in('id', ids)` candidate update.

**4. Guardrails.** None beyond the candidate-status logic.

**5. Reusability.** This is the closest existing thing to a "1 deal, N contacts" bulk affordance — relevant once the `lead_groups` rollout (PROGRESS.md PR 2.x) is finished and stakeholders are first-class on the lead list.

---

## Multi-select state machinery — patterns in use

| File | Variable | Type | Notes |
|---|---|---|---|
| [LeadTable.tsx:294](src/components/dashboard/LeadTable.tsx:294) | `selectedLeads` | `Set<string>` | Page-aware: select-all checkbox at the table head selects only the current page's ids; a "Select all N filtered" link at [line 1288–1297](src/components/dashboard/LeadTable.tsx:1288) escapes the page boundary |
| [Leads.tsx:55](src/pages/Leads.tsx:55) | `selectedIds` | `Set<string>` | Whole-list select; no pagination on this page |
| [PendingLeadsTab.tsx:214](src/components/leads/PendingLeadsTab.tsx:214) | `selected` | `Set<string>` | Drops stale ids when list mutates ([line 257–263](src/components/leads/PendingLeadsTab.tsx:257)) — only surface that does this |
| [BulkAutomationDialog.tsx:154](src/components/dashboard/BulkAutomationDialog.tsx:154) | `checked` | `Set<string>` | Dialog-internal; auto-pre-checks eligible leads, resets on lead-id-list change |

**Consistent pattern:** `Set<string>` of lead ids, mutated immutably via `new Set(prev)` + add/delete. No shared `useMultiSelect` hook exists — same logic re-implemented in each file.

---

## Sticky action bar — what exists

- **Only PendingLeadsTab has a real sticky bar** — `sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-card p-3 shadow-sm` at [PendingLeadsTab.tsx:542–566](src/components/leads/PendingLeadsTab.tsx:542).
- LeadTable's action strip ([line 702–891](src/components/dashboard/LeadTable.tsx:702)) is **inside the CardHeader and scrolls away with the table**. Not sticky, even though it visually resembles one.
- Leads.tsx header bulk strip ([Leads.tsx:392–413](src/pages/Leads.tsx:392)) is also inside CardHeader — not sticky.

If a new Lead List redesign wants a sticky bulk bar, copy PendingLeadsTab's implementation.

---

## Pagination — what exists

Only **one** place: [LeadTable.tsx:302–304](src/components/dashboard/LeadTable.tsx:302) (`pageIndex`, `showAll`, `PAGE_SIZE = 25`).

Render: [LeadTable.tsx:1280–1335](src/components/dashboard/LeadTable.tsx:1280):

- Footer row showing "1–25 of 287" range.
- Prev / Next buttons disabled at boundaries.
- "Page 2 / 12" indicator.
- "Show all" / "Paginate" toggle (no virtualization — flips to full list render).
- "Select all 287 filtered" link appears in the footer when some-but-not-all of the current page is selected and `selectedLeads.size < totalCount` ([line 1288](src/components/dashboard/LeadTable.tsx:1288)).
- Reset to page 0 on `leads.length`, `searchQuery`, or `revenueStateFilter` change ([line 309](src/components/dashboard/LeadTable.tsx:309)).

`/app/leads` (Leads.tsx) and PendingLeadsTab have NO pagination — they render the full result set.

---

## Things this app does NOT have

Confirmed by grep over `src/`:

- **Bulk archive / mark inactive** — no UI. Inbox has an "Archived" *filter tab* ([InboxView.tsx:162](src/components/inbox/InboxView.tsx:162)) but it's a query filter, not an action.
- **Bulk tag / categorize** — no tagging UI anywhere.
- **Bulk assign to rep / owner reassignment** — the only "reassign" matches are for meeting summaries ([MatchedMeetingSummariesCard.tsx:121](src/components/settings/MatchedMeetingSummariesCard.tsx:121), [MeetingsTab.tsx:270](src/components/lead/MeetingsTab.tsx:270)), not leads.
- **Bulk snooze / dismiss action** — `PriorityActions.tsx` snooze and permanent-dismiss are per-row only. No multi-select equivalent.
- **Bulk pause / resume automation** — B1 enables; no inverse.
- **Bulk export to CSV** — zero matches for `exportCSV`, `download`, etc. in `src/`.
- **Inbox bulk operations** — `ConversationList` has no checkboxes or selection state.
- **Bulk anything in Lead Detail** — single-lead surface throughout.

---

## Reuse map — for a Phase 2b "Lead List bulk-mover" redesign

### Lifts in directly (no adaptation)
- **`BulkAutomationDialog`** ([B1](#b1-bulk-enable-automation)) — takes `selectedLeads: EnrichedLead[]`, fully self-contained.
- **`bulkUpdateLeadStage(leadIds, stage)`** ([B3](#b3-bulk-stage-change), [supabaseQueries.ts:1889](src/lib/supabaseQueries.ts:1889)) — clean shared helper, `.in()`-batched. Template for any new bulk RPC.
- **Pagination footer** ([LeadTable.tsx:1280–1335](src/components/dashboard/LeadTable.tsx:1280)) — Prev/Next + "Select all N filtered" + show-all toggle. Self-contained.
- **`parseLeadFile()`** ([parseLeadFile.ts:557](src/lib/parseLeadFile.ts:557)) — file → ParsedLead[]; used twice already.
- **`gmail-bulk-sync` / `outlook-bulk-sync`** edge functions — accept `{ leadIds: string[] }`.
- **`DismissedListsDialog`** — drops in unchanged if we want allowlist/blocklist management on the new page.
- **Sticky action-bar markup** from [PendingLeadsTab.tsx:542–566](src/components/leads/PendingLeadsTab.tsx:542) — copy-pastable shell.

### Needs light adaptation
- **Per-row checkbox + select-all-on-page** logic from `LeadTable.tsx` ([lines 334–386, 901–908, 1045](src/components/dashboard/LeadTable.tsx:334)) — should be extracted into a reusable `useMultiSelect(items, { pageIds })` hook so a redesign doesn't need to re-derive `allOnPageSelected` / `someOnPageSelected` from scratch.
- **B2 Bulk move to nurture** — currently inline in `LeadTable`'s render tree. Promote to `<BulkNurtureDialog>` mirroring B1's shape (categorize-then-confirm with eligibility flags). Worth doing because B2 has zero guardrails today.
- **B5/B6 bulk delete** — two parallel implementations. Extract one `<BulkDeleteDialog>` + a `bulkDeleteLeads(leadIds)` helper using `.delete().in('id', ids)`. Use that helper in both surfaces.
- **B4 bulk source change** — promote the `updateSourceFromTable` loop into a `bulkUpdateLeadSource(ids, key)` helper.
- **Optimistic-update + rollback + retry-toast** pattern from PendingLeadsTab ([line 366–399](src/components/leads/PendingLeadsTab.tsx:366)) — extract into a reusable `useBulkAction(items, mutateFn)` hook. This is the best UX in the existing codebase; today it only powers candidate approve/dismiss.

### Build fresh
- **Bulk pause / resume automation** — no inverse to B1 exists. New dialog needed (or a single "Automation" dropdown that toggles).
- **Bulk owner reassignment** — no precedent. Plain `<Select>` of workspace members + `.update({owner_user_id}).in('id', ids)`. Needs admin-only RLS check (`is_workspace_admin()`).
- **Bulk archive / mark inactive** — define what "archived" means on leads first (current Inbox filter uses `status IN ('lost','unresponsive','disqualified')` per [inboxQueries.ts:98](src/lib/inboxQueries.ts:98)). If we adopt that, a bulk action is `.update({status:'unresponsive'}).in('id', ids)`.
- **Bulk tag / categorize** — no `tags` table exists. Schema-level work.
- **Bulk export CSV** — completely missing. Easiest: client-side `lead → CSV row` per selection. No backend needed.
- **Bulk snooze action queue** — analogous to single-row snooze in `PriorityActions.tsx`. Wrap `dismissLeadAction(leadId, days)` calls. Trivial once an action queue exists (per [AUDIT.md](AUDIT.md) Reuse vs Build).
- **A reusable `<BulkActionStrip>` shell** — would consolidate the three near-duplicate strips (LeadTable, Leads.tsx, PendingLeadsTab) into one component with slots for action buttons. Today each surface owns its own.

### Single biggest lift
Extracting `useMultiSelect(items, { pageIds? })` + `useBulkAction(items, mutator, { optimistic, retry })` hooks would clean up all four current implementations and make every new bulk op a one-line wiring exercise.
