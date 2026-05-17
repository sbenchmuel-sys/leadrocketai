
## Goal

When Outlook is the connected mail provider, no user-facing string should say "Gmail". Buttons, badges, and deep links should reflect the active provider, and "Open in Outlook" should open an Outlook compose window pre-filled the same way "Open in Gmail" does today. Personal Outlook mailboxes get the correct OWA host.

## Root cause

Two hooks coexist:

- `useGmailConnection()` — Gmail-only, reads `gmail_connections`. Several screens still gate UI on this.
- `useMailSync()` — provider-aware, reads `mail_accounts` (Gmail + Outlook) with `gmail_connections` legacy fallback. Already exposes `provider`, `providerLabel`, `activeAccount`, `isConnected`.

Anywhere UI gates on `useGmailConnection()`, an Outlook-only user falls through to the "Connect Gmail" branch. Some send paths also hit `gmail-send` directly, and `EmailActionDialog` has a hardcoded "Open in Gmail" deep link with no Outlook equivalent.

## Changes

### A. Provider-aware connection gating

1. `src/pages/LeadDetail.tsx` — replace `useGmailConnection().isConnected` with `useMailSync().isConnected`. Pass through to `LeadDetailHeader`.
2. `src/components/lead/LeadDetailHeader.tsx` — change fallback label from `Connect Gmail` to `Connect inbox` (links to `/app/settings`).

### B. "Open in Outlook" deep link in EmailActionDialog

3. `src/components/dashboard/EmailActionDialog.tsx`
   - Add `buildOutlookComposeUrl(to, subject, body, email?)` that picks the OWA host **per account** based on the email domain:
     - **Personal** (`outlook.com`, `hotmail.com`, `live.com`, `msn.com`, `passport.com`) → `https://outlook.live.com/owa/?path=/mail/action/compose&to=...&subject=...&body=...`
     - **Work/school** (everything else, including custom domains on Microsoft 365) → `https://outlook.office.com/mail/deeplink/compose?to=...&subject=...&body=...`
   - Helper `isPersonalOutlookDomain(email)` lives in `src/lib/mailProviders/composeUrl.ts` alongside an extracted `buildGmailComposeUrl` so both providers share one module.
   - Generalize `handleOpenInGmail` → `handleOpenInProvider`. Branch on `activeMailProvider`. Save draft with `draft_type: 'outlook_compose'` for Outlook.
   - Replace the two split buttons (Open in Gmail vs hidden) with one button whose label/icon/handler depends on `activeMailProvider`: `Open in Outlook` when Outlook, `Open in Gmail` when Gmail, hidden when nothing connected.
   - Use `activeAccount?.email_address ?? connection?.gmail_email` to feed the compose URL builder so per-account host detection works.

### C. Send paths still hitting `gmail-send` directly

4. `src/components/inbox/ReplyComposer.tsx` (~lines 230–246) — replace the direct `supabase.functions.invoke("gmail-send", …)` call with `useMailSync().sendEmail(...)`. Drop the hardcoded "Gmail needs reconnection" string — the hook surfaces the right `providerLabel`.

### D. Optional polish F — rename to provider-neutral components

5. Move and rename:
   - `src/components/gmail/GmailSyncButton.tsx` → `src/components/mail/MailSyncButton.tsx` (export `MailSyncButton`).
   - `src/components/gmail/SendEmailButton.tsx` → `src/components/mail/SendEmailButton.tsx` (no rename, just relocate).
   - Keep `src/components/gmail/GmailConnectionCard.tsx` where it is — it's the Gmail-specific settings card, intentionally separate from `OutlookConnectionCard.tsx`.
6. Update imports:
   - `src/components/lead/LeadDetailHeader.tsx`
   - `src/components/lead/DraftsTab.tsx`
   - `src/components/lead/MeetingsTab.tsx`
   - Any other consumers found via grep on `@/components/gmail/(GmailSyncButton|SendEmailButton)`.
7. Update the `Send via {providerLabel}` button text inside the moved `SendEmailButton` to also adapt its dialog title (already does via `providerLabel`).
8. Comment in `DraftsTab.tsx` line 550 (`{/* Send via Gmail for email channel */}`) → `{/* Send via active mail provider */}`.

### E. Strings to leave alone

- `Terms.tsx`, `Privacy.tsx` — legal copy explicitly about Gmail.
- `GmailConnectionCard.tsx` — Gmail-specific Settings card.
- `ConnectInboxStep.tsx` — onboarding offers both options by design.
- DB enums (`gmail_inbound`) and column names (`gmail_thread_id`, `gmail_message_id`) — internal identifiers; Outlook already reuses them.
- `Leads.tsx` copy "Connect Gmail or Outlook" — correct when nothing is connected.

## Implementation order

1. Extract `buildGmailComposeUrl` and add `buildOutlookComposeUrl` + `isPersonalOutlookDomain` into `src/lib/mailProviders/composeUrl.ts`.
2. Wire `EmailActionDialog` to the new helpers, generalize the button.
3. Swap `LeadDetail` to `useMailSync`; relabel header fallback to "Connect inbox".
4. Route `ReplyComposer` through `useMailSync().sendEmail`.
5. Move + rename `GmailSyncButton` → `MailSyncButton`, relocate `SendEmailButton`, update all imports.
6. Manual QA on Outlook-only workspace:
   - Lead header shows "Sync Outlook", no "Connect Gmail".
   - Composer button reads "Open in Outlook" and opens the correct OWA host based on the account's email domain (test with `@outlook.com` and a work `@company.com` if available).
   - Inbox reply uses `outlook-send`.
7. Repeat on Gmail-only workspace — confirm no regressions.

## Open hazards / non-goals

- Personal-vs-work detection is heuristic by email domain. A custom personal domain hosted on outlook.com would be misrouted to OWA business host, which still works (just opens the wrong tenant chooser). Acceptable for pilot.
- Not refactoring `useGmailConnection` itself — still needed by `GmailConnectionCard` and the OAuth callback (`?gmail_connected=true`).
