

# Gmail vs Outlook Integration: Gap Analysis & Implementation Plan

## Overview

The Gmail integration is mature with ~1,568 lines of sync logic, extensive automation, safety guards, and bug fixes. The Outlook integration started minimal but has been progressively brought to parity. This document tracks the current status of all identified gaps.

---

## Phase 1: Fix Critical Gaps — ✅ COMPLETE

### 1. ✅ Create `outlook-sync` edge function
Created `supabase/functions/outlook-sync/index.ts` mirroring `gmail-sync`: fetches messages via Graph API, filters direct rep-lead conversations, stores as `interactions`, runs `deriveStage`/`deriveAction`, includes all safeguards (newsletter guard, bounce detection, OOO detection, unsubscribe detection).

### 2. ✅ Update `automation-executor` to support Outlook
Replaced Gmail-only connection check with `mail_accounts` lookup. Routes sends to either `gmail-send` or `outlook-send` based on provider. Added sender-mismatch safety guard that blocks sends when no `mail_accounts` entry exists.

### 3. ✅ Add post-send logic to `outlook-send`
Added `interactions` record creation after successful send, lead timestamp/stage updates, `skipStateUpdate` flag support, and AI analysis for manual sends.

### 4. ✅ Enhance `outlook-webhook` with safeguards
Added direct-conversation filter, bounce detection, OOO detection using shared `isOutOfOfficeReply` utility, and unsubscribe detection with the newsletter-safe regex.

---

## Phase 2: Parity Features — ✅ COMPLETE

### 5. ✅ Add 404 retry logic to `outlook-send`
Implemented: if reply endpoint returns 404 (deleted thread), strips conversationId and retries as a fresh email.

### 6. ✅ Add `needsReconnect` flag to Outlook error responses
Outlook error responses now include `needsReconnect: true` for auth-related failures, triggering frontend reconnection prompts.

### 7. ✅ Fix unsubscribe regex in `automation-executor`
Updated to match the newsletter-safe version that avoids false positives from bulk mail List-Unsubscribe headers.

### 8. ✅ Fix the `from`/`to` variable ordering bug in `gmail-sync`
Moved header extraction above the strict direction filter to prevent runtime errors from using undefined variables.

### 9. ✅ Create unified `useMailSync` hook / Outlook frontend support
`OutlookProvider` in `src/lib/mailProviders/OutlookProvider.ts` handles send and validation. `MailProviderRouter` provides provider-agnostic resolution. Settings UI includes `OutlookConnectionCard`.

---

## Phase 3: Unified Architecture — ✅ COMPLETE

### 10. ✅ Extract shared sync logic into `_shared/syncEngine.ts`
Created `supabase/functions/_shared/syncEngine.ts` with shared types, constants, and functions:
- `deriveStage`, `deriveAction`, `deepMergeCadence`
- `htmlToPlainText`, `computeMetricsFromInteractions`, `buildLeadUpdate`
- Both `gmail-sync` and `outlook-sync` now import from this shared module.

### 11. ✅ Unify the automation pipeline via `MailProviderRouter`
`automation-executor` uses `mail_accounts` lookup to resolve the correct provider, with sender-mismatch guard. `MailProviderRouter` on the frontend provides `resolveProvider()` for provider-agnostic send resolution.

---

## Additional Safeguards Implemented

- **Sender mismatch guard** in `automation-executor`: blocks automated sends if resolved sender doesn't match `mail_accounts`, preventing emails from wrong addresses.
- **Outlook token auto-refresh** in `_shared/outlookTokens.ts`: transparently refreshes expired tokens before Graph API calls.
- **Subscription health check** in `outlook-subscription-check`: cron job renews expiring Graph subscriptions.
- **Outlook health endpoint** in `outlook-health`: returns mailbox status for all Outlook accounts in a workspace.

---

## Current Status

| Feature | Gmail | Outlook | Status |
|---|---|---|---|
| Email sync (pull history) | ✅ | ✅ | Done |
| Interaction recording | ✅ | ✅ | Done |
| Automation send pipeline | ✅ | ✅ | Done |
| Post-send state updates | ✅ | ✅ | Done |
| Stage derivation | ✅ | ✅ | Done (shared engine) |
| Action/cadence scheduling | ✅ | ✅ | Done (shared engine) |
| Direct-conversation filter | ✅ | ✅ | Done |
| Newsletter guard | ✅ | ✅ | Done |
| Bounce detection | ✅ | ✅ | Done |
| OOO detection | ✅ | ✅ | Done |
| Unsubscribe detection | ✅ | ✅ | Done |
| 404 thread retry | ✅ | ✅ | Done |
| Reconnect prompt | ✅ | ✅ | Done |
| Frontend provider support | ✅ | ✅ | Done |
| Sender mismatch guard | ✅ | ✅ | Done |
| Shared sync engine | — | — | Done (`_shared/syncEngine.ts`) |

---

## Known Issues

- **Outlook account in error state**: The sole Outlook mail_account (`cbenchmuel@hotmail.com`) has `status=error` due to a Graph subscription creation failure (`ValidationError: "OK"`). This likely indicates the webhook notification URL is not properly registered/accessible in the Azure App Registration. Token is valid but will expire soon.
- **No active Outlook subscriptions**: 0 rows in `outlook_subscriptions`, meaning real-time webhook notifications are not flowing.

## Next Steps

1. Verify Azure App Registration has the correct webhook notification URL configured and publicly accessible.
2. Re-trigger Outlook OAuth flow or manually invoke `outlook-subscription-check` to restore the subscription.
3. Run a full end-to-end test: connect Outlook account → sync emails → verify interactions appear → send automated email → verify post-send state updates.
