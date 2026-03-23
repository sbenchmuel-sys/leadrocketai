

## Plan: Feature-Flagged Admin Tuning Tools

### How It Works

**Two environments, one codebase:**

- **Preview (your testing URL)**: You set `VITE_ADMIN_TUNING=1` as an environment variable. The app builds with the tuning tools visible. You see AI reasoning, can submit corrections, and lock sections. A small "TUNING MODE" badge appears in the sidebar so you always know you're in the internal view.

- **Published (leadrocketai.lovable.app)**: The env var is absent, so `flags.admin_tuning` is `false`. The tuning UI never renders — users see none of it. But the **backend still uses corrections you've saved**. The `lead_ai_corrections` table feeds into every future AI generation for that lead, so your tuning work silently improves output for everyone.

**Flow:**
```text
You (preview, TUNING=1)          End user (published, no flag)
─────────────────────────        ─────────────────────────────
Generate email for Lead X        Generate email for Lead X
See AI Reasoning panel           (no reasoning panel)
Notice wrong assumption
Click "Correct AI" → save        
                                  ↓
Next generation for Lead X       Next generation for Lead X
Prompt includes your             Prompt includes your
correction automatically         correction automatically
→ Better output                  → Better output
```

### Changes

**1. `src/lib/featureFlags.ts`** — Add one flag:
```ts
admin_tuning: import.meta.env.VITE_ADMIN_TUNING === "1",
```

**2. `src/components/dashboard/EmailActionDialog.tsx`** — Restructure the action bar:

- **Remove** "Fix grammar", "Shorten", "Answer with KB" buttons and their handlers (`handleFixGrammar`, `handleShorten`, `handleAnswerWithKB`)
- **Gate behind `flags.admin_tuning`**:
  - "Why this draft?" button (Brain icon) — toggles reasoning panel. Has a dot indicator when reasoning exists
  - "Correct AI" button (ThumbsDown icon) — opens correction textarea inline below the editor
  - Section lock buttons (greeting/body/cta) — moved from above textarea into the action bar as a dropdown
- **Keep for all users**: "Add meeting CTA", "Rewrite tone", "Undo"

New action bar layout:
- **All users see**: `Add meeting CTA` · `Rewrite tone ▾` · `Undo`
- **You also see** (when flag is on): `Why this draft?` · `Correct AI` · `Lock sections ▾`

**3. `src/components/DashboardLayout.tsx`** — Add a small "TUNING MODE" badge in the sidebar (bottom section) when `flags.admin_tuning` is true, so you always know which environment you're in.

### What stays active regardless of the flag

- The `lead_ai_corrections` table and RLS policies
- The prompt injection in `ai_task/index.ts` that reads corrections and feeds them as `=== LEAD-SPECIFIC CORRECTIONS ===`
- The `stripLeakedReasoning` function that prevents reasoning leaks in output
- The client-side `stripReasoningClient` in `generateDraft.ts` that separates reasoning from email text

### Files changed

| File | Change |
|------|--------|
| `src/lib/featureFlags.ts` | Add `admin_tuning` flag |
| `src/components/dashboard/EmailActionDialog.tsx` | Remove 3 buttons, gate tuning tools behind flag, restructure action bar |
| `src/components/DashboardLayout.tsx` | Add "TUNING MODE" indicator badge |

No backend or database changes needed — the corrections system already works.

