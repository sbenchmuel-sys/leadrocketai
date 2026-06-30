## Goal

On the campaign content step (the "Build the messages" screen), give reps a second path: **Write my own**. Empty touches up front, full inline editing, merge fields they can insert with one click or by typing `{{`, and a "Generate this one" button per touch if they want AI help on a single message. The existing "Build the messages" flow stays exactly as is.

This is a **small change**. We already have all the plumbing:
- `saveStepEdit()` writes manual content per step.
- `generateTouch()` already exists for single-touch generation.
- `ai_task` already normalises tokens like `{FirstName}`, `{Company}`, `{RepFirstName}` at send time, so any tokens the rep types just flow through the existing live-send pipeline.

No DB migration, no edge-function change. Frontend only.

---

## UX

**Empty state (current "Build the messages" card)** — add a secondary option:

```text
[ Build the messages ]   or   Write my own
```

`Write my own` flips the section into manual mode and renders one `TouchCard` per active step in **edit mode** with empty fields. The rep saves each one with the existing Save button (already wired to `saveStepEdit`).

**Per-touch toolbar (edit mode only):**

- Chip row above the body: `First name` `Company` `Industry` `Rep first name` `Meeting link` — click inserts the token at the cursor.
- Typing `{{` inside subject/body/talking-points/sms opens a small popover with the same tokens (filtered as you type), Enter inserts. Esc closes.
- Tokens use the format the resolver already accepts: `{FirstName}`, `{LastName}`, `{Company}`, `{Industry}`, `{RepFirstName}`, `{MeetingLink}`. Meeting-link token only shown for email steps where the rep can also toggle "Include a meeting link" (existing per-step flag).
- One-line helper under the toolbar: *"Fields fill in automatically when each message sends."*

**Per-touch "Generate this one" button** (manual mode, when the body is empty):
- Calls existing `generateTouch(campaign, step, variant)`, then reloads. Same path the AI flow uses.
- After generation, the rep can still edit freely; the row gets the standard "edited by you" badge as soon as they save changes.

**Mode switch / overwrite** (per the user's answer):
- A small mode pill at the top of the section: `Write my own` ⇄ `Use the builder`.
- Clicking the other mode when content already exists opens a confirm: *"Switching to the builder will replace your messages with AI-written ones. Continue?"* On confirm, run `generateAllTouches(..., { force: true })`. Going the other direction (builder → manual) confirms the same way and clears existing rows for the current variant via `saveStepEdit` with empty fields.
- Mode is **local UI state** only — no schema change. The mode pill is hidden once content exists and matches the path it came from; it just controls the initial empty-state affordance and the confirm copy.

---

## Files touched

1. **`src/components/automations/CampaignContentReview.tsx`**
   - Empty-state card: add `Write my own` secondary button next to `Build the messages` (or per-variant equivalent). Sets `mode = "manual"` and seeds empty `StepContent` rows for the variant so each `TouchCard` renders in edit mode.
   - Mode pill at the top once `mode` is set; confirm dialog on switch.
   - Pass a new `onGenerateOne` prop down to `TouchCard` that calls `generateTouch` + `onChanged`.

2. **`src/components/automations/CampaignContentReview.tsx` → `TouchCard`**
   - When `editing` is true, render a new `<MergeFieldToolbar />` above the subject/body/talking-points/sms textarea.
   - Wire each `Textarea`/`Input` through a shared `useMergeFieldEditor` hook that:
     - tracks the active textarea ref + caret,
     - inserts a token at the caret on chip click,
     - watches for `{{` and opens a small `<Popover>` of token suggestions; Enter/click inserts, Esc/blur closes.
   - Show `Generate this one` button when the row is empty in manual mode.

3. **New: `src/components/automations/MergeFieldToolbar.tsx`** (~60 lines)
   - Small presentational component: chips + helper line. Exports the canonical token list so the autocomplete and chips stay in sync.

4. **New: `src/lib/mergeFields.ts`** (~40 lines)
   - `MERGE_FIELDS` constant: `[{ token: "{FirstName}", label: "First name" }, …]`.
   - `insertAtCursor(el, text)` helper (works for `<input>` and `<textarea>`, preserves selection).
   - Pure, easy to unit test.

5. **`src/lib/generateCampaignContent.ts`**
   - No changes needed — `generateTouch` already exists and is exported. Just consumed by the new "Generate this one" button.

6. **Tests** (`src/lib/__tests__/mergeFields.test.ts`)
   - Insert at caret in middle / start / end of value.
   - `{{` trigger detection.

No backend migration, no edge-function change, no `types.ts` change.

---

## Technical notes for reviewers

- The token format (`{FirstName}` etc.) is the same one `ai_task` already normalises in `normalizeCampaignTemplatePlaceholders`, so manual templates flow through the live-send pipeline without special-casing.
- `saveStepEdit` already sets `is_edited = true` on the row, which prevents the option picker / Rewrite from silently overwriting the rep's wording — the same protection we built for the AI flow applies automatically.
- The `{{` autocomplete is a controlled popover anchored to the textarea; we keep it inside the existing card to avoid z-index issues with the dialog stack.
- Variant-awareness: when the rep is on a specific industry variant and chooses `Write my own`, only that variant gets seeded blank rows. Other variants stay untouched (same scoping the builder already uses).
- Mode is not persisted — if the rep leaves and comes back after writing anything, the section just shows their content with the normal edit/rewrite controls; the mode pill only matters in the empty state.

---

## Out of scope

- Saving custom templates as a reusable library (could be a follow-up).
- Rich text / HTML email composition (we stay on plain text like the rest of the platform).
- Importing a `.docx` / Gmail draft as a template (separate ask).
