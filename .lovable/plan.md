## Problem 1 — "no company postal address (CAN-SPAM)" error on Send

The cold outreach send path (`supabase/functions/_shared/coldOutreach.ts`) refuses to send any email when the workspace row's `cold_outreach_postal_address` is blank. This is a legal floor (CAN-SPAM), so we do **not** bypass it. Your Binah.ai workspace currently has that field empty, so every Send/auto-send fails with this 400.

This field is user-entered only (never AI-populated) and lives in **Settings → Cold Outreach Safety → Company mailing address** (`src/components/settings/ColdOutreachSafetyCard.tsx`).

### Fix
1. **You enter the address once** in Settings → Cold Outreach Safety. After saving, Sends will go through.
2. **Better error surfacing** in `src/components/queue/OutreachCard.tsx`: when the edge function returns `"no company postal address (CAN-SPAM)"`, show a toast with a "Open Settings" action that deep-links to `/app/settings#cold-outreach-safety`, instead of the generic "edge function returned a non-2xx" error overlay.
3. **Pre-flight check** in the Outreach tab: if the workspace has no postal address, show a small inline banner above the Outreach list ("Add your company mailing address to start sending — required by CAN-SPAM") with the same Settings link. This stops reps from clicking Send and seeing a red error.

No schema, no edge function logic changes — the floor stays exactly where it is.

## Problem 2 — Signature is not shown before Send and not appended

Today: `rep_signatures` exists (Settings → Signatures) but **nothing in the outreach send path reads it**. The preview body in `OutreachCard` is the AI draft only, and `outreach-touch-action` sends that body verbatim — so the signature never appears in the sent email and the rep can't see/edit it before sending.

### Fix (keep it simple — one path, visible in preview)
1. **Client-side append on load** in `OutreachCard.tsx`:
   - Fetch the rep's **default** signature via the existing `getSignatures()` helper (`src/lib/repProfileQueries.ts`) once when the card mounts.
   - Initialize `body` state as `draftBody + "\n\n" + defaultSignature.signature_text` (only if a default exists and the body doesn't already end with it — simple suffix check).
   - The rep sees the full email (draft + signature) in the existing editable `<Textarea>` and can tweak either part before clicking Send.
2. **Server stays unchanged.** `outreach-touch-action` already sends the body string the client gives it; appending in the client means the signature is part of what gets sent, and the CAN-SPAM footer is still added on top by `coldOutreach.ts`. No risk of double-append.
3. **Auto-send path** (`automation-executor`): mirror the same append — load the campaign owner's default `rep_signatures` row alongside the existing `rep_profiles` lookup, and concatenate `signature_text` to the resolved body before calling `sendColdEmailTouch`. One small block, no new tables.
4. **Empty case**: if the rep has no default signature, behavior is unchanged (no signature appended, no error). A subtle hint under the Textarea — "No signature set · Add one in Settings" — links to Settings → Signatures.

### Order of sent email (unchanged structure, signature is new)
```text
{AI draft body}

{Rep signature — NEW, visible in preview}

— CAN-SPAM footer (postal address + unsubscribe), added by coldOutreach.ts
```

## Files touched
- `src/components/queue/OutreachCard.tsx` — load default signature, append into editable body, better CAN-SPAM toast, "No signature" hint.
- `src/pages/Queue.tsx` (or wherever the Outreach tab list lives) — missing-postal-address banner.
- `supabase/functions/automation-executor/index.ts` — append default signature on the auto-send branch.

No DB migrations. No changes to the CAN-SPAM floor or footer code.
