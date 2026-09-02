# Outbound + Inbound — Implementation Plan

Full plan for fixing how starter cadences generate copy (warm vs cold), reconciling the
cold email design, and switching collateral to rep-uploaded one-pagers. Built from the
investigation in the 2026-06 outreach review. See also `CAMPAIGN_MANAGER_BUILD_PROMPTS.md`
(the original Outreach Unit A–E plan) and `PROGRESS.md`.

## Scope

**In:** (1) warm/cold routing for starter cadences, (2) reconciled, de-AI'd email copy,
(3) upload-real-collateral, (4) offer that collateral in follow-up emails only when present.
Covers both **outbound** (cold) and **inbound** cadences.

**Out (separate future plan):** the premium per-lead AI engine for warm campaigns and
Re-engage's return; send-time file *attachment* (collateral stays a hosted link).

**Four PRs, built and merged in order off `origin/main`:**

| PR | Title | Migration? | Touches sender? |
|---|---|---|---|
| 1 | Motion-aware starters (warm routing + hide Re-engage) | No | No |
| 2 | Reconcile & de-AI the cold/inbound copy | No | Yes (prompts) |
| 3 | Upload real collateral (upload-first screen) | **Yes** | No |
| 4 | Offer the one-pager in emails (gated on upload) | No | **Yes (deepest QA)** |

### Why this shape (root causes)

- Every starter clones with `motion: "outbound_prospecting"` hardcoded in
  `createCampaignWithSteps` (`src/lib/campaignQueries.ts` ~L217); `generateCampaignContent.ts`
  always uses cold `pre_email_*` prompts + a "cold prospects" audience. So Inbound/Re-engage
  came out cold.
- Cold campaign copy is generated once at review time (static `campaign_step_content`) and
  sent via `coldOutreach.resolveTouchContent` (first-name interpolation only). Templates always
  run the cold prompt in **LOW-INTEL MODE** (no lead attached) whose fallback is "ask one
  neutral use-case question" — that is the "looks like AI" output.
- The cold email design lives in 5 conflicting places (the prompt, the motion block, the
  default instructions, the starter text, the collateral plan); the prompt wins at send.
- Collateral upload backend shipped (public `campaign-collateral` bucket + `asset_*` columns +
  `src/lib/collateralAssets.ts`) but is wired into no screen; AI-generated collateral isn't
  professional enough to send.

---

## Standard PR lifecycle (apply to every PR)

1. **Branch from main** (working branch can be far behind):
   `git fetch origin && git switch -c <branch> origin/main`. If built before the previous PR
   merges, stack on it and **retarget base to main yourself** once it merges (GitHub won't
   auto-retarget).
2. **Implement** with the paste-ready prompt.
3. **Local checks:** `tsc -b --noEmit` (the `-b` matters — plain `tsc --noEmit` checks nothing
   here and passes vacuously), `npm test`, `npm run build`; for any `supabase/functions`
   change also `npm run test:edge`.
4. **Self-review:** `/code-review high` (use `/code-review ultra` for PR 4 — it touches the sender).
5. **Open PR to `main`** with `gh`.
6. **Codex loop:** comment `@codex review`. It can lag or go silent — judge "clean" by the
   absence of **non-outdated** review threads, not by waiting for a confirming review. Address
   threads, push, re-request until clean.
7. **QA:** run `/drivepilot-qa` on the diff (focus per PR). Apply fixes, re-run until it passes.
8. **Merge** (squash) once 3–7 are green.
9. **Post-merge migration (PR 3 only):** tell Lovable *"Apply migration `<filename>`"* (it
   applies to prod **and** regenerates `src/integrations/supabase/types.ts` together — don't
   regenerate types separately). Then **apply the same migration to staging yourself** via the
   `.env.staging` pooler URL.
10. **Verify on staging** before considering it done.

---

## PR 1 — Motion-aware starters

**Goal:** Inbound starter writes warm, inbound-appropriate copy; Cold stays byte-for-byte
identical; Re-engage hidden until the premium engine ships. No DB change (re-clone existing
drafts).

**Paste-ready prompt:**

> In DrivePilot, fix starter cadences so each starter generates copy that matches its purpose.
> Work against `origin/main` on a fresh branch. Today every starter is stamped
> `motion: "outbound_prospecting"` in `createCampaignWithSteps` (`src/lib/campaignQueries.ts`
> ~L217), and `generateCampaignContent.ts` always uses cold prompts + a "cold prospects"
> audience, so the Inbound starter sends cold emails.
>
> 1. Add a `motion` field to `StarterCadence` (`src/lib/starterCadences.ts`) and to
>    `CreateCampaignInput` (`src/lib/campaignQueries.ts`). Map `inbound_intro → "inbound_response"`,
>    `cold_outbound → "outbound_prospecting"` (leave `reengage`'s value set but unused — step 3).
>    In `createCampaignWithSteps`, persist `input.motion` instead of the hardcoded string,
>    **defaulting to `"outbound_prospecting"` when undefined** so every other caller is byte-identical.
> 2. Make `generateCampaignContent.ts` motion-aware by threading `campaign.motion` into
>    `emailTaskForStep`, `buildLeadContext`, and `authoringInstructions`:
>    - `emailTaskForStep` `inbound_response` branch: `intro → inbound_intro`;
>      `breakup → pre_email_4_breakup`; the **first** email follow-up → `inbound_followup_1`,
>      every later email follow-up → `inbound_followup_2` (compute the email-step ordinal from
>      the campaign's steps, mirroring `automation-executor` ~L840). **Leave the
>      `outbound_prospecting` branch exactly as-is.**
>    - `buildLeadContext`: for `inbound_response`, frame the audience as inbound leads who
>      reached out (website/referral/inquiry), not "cold prospects."
>    - `authoringInstructions`: for inbound email, a warm inbound-reply template (they
>      contacted us first; no cold pitch).
> 3. Hide the Re-engage starter: add `hidden?: boolean` to `StarterCadence`, set it on
>    `reengage`, and filter hidden cadences out of what `StarterCadencePicker` renders (keep the
>    data for later).
> 4. Golden tests (vitest, mirror `src/lib/__tests__/campaignResolver.golden.test.ts`): Cold
>    maps to the same four tasks (`pre_email_1_intro` / `pre_email_2_followup` /
>    `pre_email_2_followup` / `pre_email_4_breakup`) and `motion === "outbound_prospecting"`;
>    Inbound maps to `inbound_intro` / `inbound_followup_1` / `inbound_followup_2` /
>    `pre_email_4_breakup` and `motion === "inbound_response"`; `reengage` is excluded from the
>    visible picker.
> 5. No migration. Do not touch the cold send path (`coldOutreach.ts`, the `campaign_touch`
>    loop). Authoring-only.

**QA focus:** authoring-only — the live cold send (`resolveTouchContent`) ignores
`campaign.motion`, so no active campaign changes behavior; `createCampaignWithSteps`
byte-identical for non-starter callers; no migration.
**Codex focus:** the inbound follow-up ordinal logic; the byte-identical guarantee on the
outbound branch.
**After merge:** re-clone existing Inbound drafts from the fixed starter.

---

## PR 2 — Reconcile & de-AI the cold/inbound copy

**Goal:** One source of truth for the cold email, value-led instead of the generic "one
question that looks like AI." Scoped to the template path so the Queue's per-lead drafts don't
change.

**Paste-ready prompt:**

> In DrivePilot the cold campaign email is defined in five conflicting places and the template
> output reads as AI-written (it always falls into LOW-INTEL MODE and asks a generic question).
> Reconcile into one value-led design, **scoped to campaign authoring** so the per-lead Queue
> draft (lead_id present) is untouched. Work against `origin/main` on a fresh branch. Read:
> `supabase/functions/_shared/prompts.ts` (`pre_email_1_intro`/`_2`/`_3`/`_4_breakup`, plus
> `inbound_intro`/`inbound_followup_1`/`_2`), `_shared/frameworks.ts` `buildMotionBlock` OUTBOUND
> blocks, `src/lib/campaignDefaults.ts` `DEFAULT_GLOBAL_INSTRUCTIONS`, and the `campaignAuthoring`
> / `campaignTemplateContract` branch in `supabase/functions/ai_task/index.ts` (~L1396 / ~L2148).
>
> 1. In the **template/authoring path only** (via `campaignTemplateContract`), replace the
>    LOW-INTEL "ask one neutral use-case question" fallback with a value-led arc: **Email 1** —
>    one specific company/industry observation + one grounded ask, **no meeting link**;
>    **Emails 2–3** — fresh angle that leads with the offer/value and may suggest a meeting;
>    **Email 4** — clean breakup. Do not change the path when `lead_id` is present.
> 2. Relax the absolute "every email must end in a question / never a calendar link" rules in
>    the OUTBOUND motion block and cold prompts so emails 2–3 may carry a meeting CTA, **gated
>    by the existing per-step `include_meeting_cta` flag** (email 1 stays link-free).
> 3. Make `DEFAULT_GLOBAL_INSTRUCTIONS` the human-readable statement of this same arc.
> 4. **Inbound:** read-through `inbound_intro`/`inbound_followup_1`/`_2` and confirm they honor
>    the same meeting-link policy and lead with a value point; adjust only if they contradict it.
>    Do not rewrite them.
> 5. Add/extend prompt-contract tests. No migration.

**QA focus (changes the production sender's output):** with `lead_id` present (Queue + live
cold send) cold output is **unchanged**; the template path no longer emits the generic
question; email-1 link suppression + the email-2/3 per-step meeting toggle both hold. Flag
every shared-vs-template-scoped edit explicitly.
**Codex focus:** that the `campaignTemplateContract` scoping genuinely spares the per-lead
path; no banned-phrase / greeting-repair regressions.

---

## PR 3 — Upload real collateral (upload-first screen)

**Goal:** Reps upload the polished one-pager they already have (per industry); AI generation
removed from the flow. **Decision:** add a `asset_ready boolean` column so a file is only
emailable after an explicit confirm.

**Migration:** `ALTER TABLE public.campaign_collateral ADD COLUMN IF NOT EXISTS asset_ready
boolean NOT NULL DEFAULT false;` (no RLS change — existing member RLS covers it).

**Paste-ready prompt:**

> In DrivePilot, rebuild `src/components/automations/CampaignCollateralSection.tsx` to be
> **upload-first**. Work against `origin/main` on a fresh branch. Add a migration
> `ALTER TABLE public.campaign_collateral ADD COLUMN IF NOT EXISTS asset_ready boolean NOT NULL
> DEFAULT false;` (the rep's "Use in emails" confirm; only `asset_ready = true` rows are
> emailable in PR 4).
>
> **Remove from the rep-facing flow:** the "Generate"/"Regenerate" buttons, inline title/body
> editing, the "technical walkthrough" type (show only the **one-pager**), and the "Link to an
> email" picker. Keep the underlying functions in code (don't delete
> `generateCampaignCollateral.ts` or the link mutation) — just take them off this screen.
> **Add:** one upload control per industry variant using the existing `uploadCollateralAsset` /
> `removeCollateralAsset` helpers in `src/lib/collateralAssets.ts` (PDF/PNG/JPEG ≤10MB;
> tap-to-browse file input, works on phones). Reuse the existing "Showing: [industry]" switcher
> and `variant_group` keying (General when none). When a file is present, show `asset_filename`
> with full-size **Replace** and **Remove** controls and a **"Use in this campaign's emails"**
> checkbox bound to `asset_ready`. Mark each industry in the switcher ✓ (uploaded) or "needed",
> and show a "Uploaded for N of M industries" line.
> **Copy:** title "One-pager"; helper "Upload the one-pager you want this campaign's follow-up
> emails to offer. Keep it free of anything confidential — the link opens publicly." No
> engineering words on screen.
> **Do NOT touch:** the storage bucket / RLS / the `collateralAssets.ts` helpers, and **no
> email/send path**. After building, `tsc -b --noEmit` + `npm run build`.

**QA focus:** workspace isolation on upload (storage RLS scopes by first path segment =
`workspace_id`); the public-bucket confidentiality warning is surfaced; `asset_ready` defaults
false.
**Codex focus:** the upload→record→confirm flow has no orphan states (file uploaded but row not
recorded, or vice-versa).
**After merge:** Lovable applies the migration + regenerates types; apply the migration to
staging too.

---

## PR 4 — Offer the one-pager in emails (gated on upload)

**Goal:** Outbound emails 2–3 and inbound follow-ups offer the uploaded one-pager **only when a
`asset_ready` file exists** for that campaign+industry. **Decision:** inject the link **at
send**, so removing the file can never leave a dead link in a prospect's inbox.

**Paste-ready prompt:**

> In DrivePilot, make follow-up emails offer the campaign's uploaded one-pager — and only when
> one exists. Work against `origin/main` on a fresh branch (after PR 3 merges). Two halves:
>
> 1. **Authoring (generation):** in `src/lib/generateCampaignContent.ts`, for the designated
>    offer steps (outbound emails 2–3; inbound follow-ups), when a `campaign_collateral` row
>    with `asset_ready = true` exists for that campaign+`variant_group`, have generation include
>    a natural one-line offer of the one-pager ending in a `{{ONE_PAGER_LINK}}` token (pass the
>    existence + filename into the `ai_task` payload so the prompt writes the sentence). If none
>    exists, no offer sentence and no token.
> 2. **Send (the gate that guarantees no dead links):** in
>    `supabase/functions/_shared/coldOutreach.ts` `resolveTouchContent`, look up the
>    campaign+industry's `asset_ready` one-pager; replace `{{ONE_PAGER_LINK}}` with its current
>    public `asset_url`, OR if no ready asset exists at send time, **strip the entire offer
>    sentence** (leave clean copy). The link is campaign/workspace-level (same for every lead) —
>    no per-rep data, no cross-rep leak.
>
> Tests: a step with a ready one-pager renders the link; the same step with no ready asset
> renders clean copy with no token and no dangling sentence; an asset removed after generation
> produces no link at send.

**QA focus (deepest — sender-touching, public link to real prospects):** the email links
**only** a present `asset_ready` asset (never a broken/empty/`{{token}}` link); the per-industry
match is exact (a Finance lead never gets the Healthcare one-pager — same fail-closed rule the
content variant uses); the public link carries nothing workspace-confidential; removing the
file mid-campaign cleanly drops the offer. Run `/code-review ultra` and `/drivepilot-qa` here.
**Codex focus:** the send-time strip logic for the no-asset case; token never escapes to the wire.

---

## Final integration pass (after all four merge)

Run one end-to-end on staging: clone the **Inbound** and **Cold** starters → confirm Inbound
reads warm and Cold reads value-led (not the old generic question) → upload a one-pager per
industry → confirm emails 2–3 offer it, and that a campaign with **no** upload offers nothing →
remove a file and confirm the next send drops the offer cleanly. Re-clone any pre-existing
Inbound drafts.
