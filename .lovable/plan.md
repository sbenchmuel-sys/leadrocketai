

# Gmail vs Outlook Integration: Gap Analysis

## Overview

The Gmail integration is mature with ~1,568 lines of sync logic, extensive automation, safety guards, and bug fixes. The Outlook integration is minimal — it handles webhook-based reply detection and basic email sending, but is missing most of the features and safeguards that Gmail has.

---

## Critical Gaps (Will Cause Bugs)

### 1. No Outlook Sync Function
**Gmail**: Has a full `gmail-sync` edge function (~1,568 lines) that pulls emails from Gmail API, stores them as `interactions`, computes lead stage, derives next actions, and runs cadence logic.
**Outlook**: Has NO equivalent. The `outlook-webhook` only detects new inbound messages and pauses automation. There is no way to:
- Pull historical emails when a lead is first created
- Populate the lead timeline with Outlook emails
- Compute stage transitions (new -> contacted -> engaged)
- Run cadence/action scheduling logic

**Impact**: Outlook leads will have empty timelines. No follow-up scheduling, no stage progression, no engagement tracking.

**Fix**: Create an `outlook-sync` edge function that mirrors `gmail-sync` — fetches messages via Graph API, stores interactions, and runs the same `deriveStage`/`deriveAction` logic.

### 2. Automation Executor is Gmail-Only
**Gmail**: `automation-executor` checks for `gmail_connections` (line 362-376) and sends via `gmail-send` (line 586). If no Gmail connection exists, leads are skipped with "No Gmail connection".
**Outlook**: Completely excluded from the automation pipeline. Outlook-connected users will never get automated emails sent.

**Impact**: All automated outreach (intro emails, follow-ups, breakup emails, nurture) will silently fail for Outlook users.

**Fix**: Update `automation-executor` to use the `MailProviderRouter` pattern — check for any connected mail account (Gmail or Outlook), then route to the appropriate send function.

### 3. Outlook Send Missing Post-Send Logic
**Gmail**: `gmail-send` creates an `interactions` record, runs AI analysis on the sent email, updates lead stage/action state, and handles `skipStateUpdate` for automated sends.
**Outlook**: `outlook-send` only sends the email and updates `last_sync_at` on `mail_accounts`. It does NOT:
- Create an `interactions` record
- Update lead timestamps (`last_outbound_at`, `last_activity_at`)
- Run AI analysis for stage transitions
- Handle `skipStateUpdate` for automation
- Move leads from "new" to "outreach" stage

**Impact**: Emails sent via Outlook won't appear in the lead timeline. Lead stages won't progress. The dashboard will show stale data.

**Fix**: Add the same post-send logic from `gmail-send` to `outlook-send` (interaction creation, lead state updates, AI analysis).

### 4. Outlook Webhook Missing Key Safeguards
**Gmail sync** has these protections that `outlook-webhook` lacks:
- **Direct conversation filter**: Gmail skips 3rd-party newsletters/notifications. Outlook processes ALL inbound messages regardless of sender.
- **Newsletter Guard (List-Unsubscribe)**: Gmail ignores unsubscribe keywords in bulk mail. Outlook has no unsubscribe detection at all.
- **Bounce detection**: Gmail detects postmaster/mailer-daemon bounces. Outlook does not.
- **OOO detection**: Gmail detects out-of-office replies and schedules re-engagement. Outlook does not.
- **Stage derivation**: Gmail recalculates lead stage on every sync. Outlook only clears `needs_action`.

**Impact**: Outlook users will get false automation pauses from newsletter notifications, won't detect bounces (wasting sends), and won't get OOO-aware scheduling.

**Fix**: Add these guards to `outlook-webhook` or create a separate processing layer.

---

## Moderate Gaps

### 5. No 404 Retry on Outlook Send
**Gmail**: If a thread is deleted (404), `gmail-send` strips the `threadId` and retries as a fresh email.
**Outlook**: No retry logic. A 404 on the reply endpoint will just fail.

### 6. No `needsReconnect` Flag on Outlook Errors
**Gmail**: Returns `needsReconnect: true` for auth errors, triggering a UI prompt.
**Outlook**: Returns generic error messages. The frontend won't know to prompt reconnection.

### 7. Frontend `useGmailSync` Hook Has No Outlook Equivalent
The `useGmailSync` hook handles syncing, sending, and milestone matching. There's no `useOutlookSync`. The `OutlookProvider` only has `sendEmail` and `validateConnection`.

### 8. Unsubscribe Detection in automation-executor
`automation-executor` (line 290-292) checks for `\bunsubscribe\b` in inbound emails — the old regex that was already fixed in `gmail-sync` to avoid newsletter false positives. This same buggy regex would affect Outlook leads if they ever reach this code path.

---

## Existing Bug in gmail-sync (from recent diff)

The strict direction filter (lines 1021-1022) uses `from` and `to` variables BEFORE they are declared (line 1048-1049). This will cause a runtime error or use `undefined`. This needs to be fixed by moving the header extraction above the filter.

---

## Implementation Plan

### Phase 1: Fix Critical Gaps (High Priority)

1. **Create `outlook-sync` edge function**
   - Mirror `gmail-sync` structure: fetch messages via Graph API `me/messages`, filter to direct rep-lead conversations, store as `interactions`
   - Reuse the same `deriveStage` and `deriveAction` logic (extract into shared module or duplicate)
   - Include all safeguards: direct-conversation filter, newsletter guard, bounce detection, OOO detection, unsubscribe detection with the fixed regex

2. **Update `automation-executor` to support Outlook**
   - Replace the Gmail-only connection check (lines 362-376) with a `mail_accounts` lookup
   - Route sends to either `gmail-send` or `outlook-send` based on provider
   - Add `ownerUserId` / service-role support to `outlook-send`

3. **Add post-send logic to `outlook-send`**
   - Create `interactions` record after successful send
   - Update lead timestamps and stage
   - Support `skipStateUpdate` flag
   - Add AI analysis for manual sends

4. **Enhance `outlook-webhook` with safeguards**
   - Add direct-conversation filter (check if sender is actually a known lead vs newsletter)
   - Add bounce detection
   - Add OOO detection using shared `isOutOfOfficeReply` utility
   - Add unsubscribe detection with the newsletter-safe regex

### Phase 2: Parity Features (Medium Priority)

5. **Add 404 retry logic to `outlook-send`** for deleted threads
6. **Add `needsReconnect` flag** to Outlook error responses
7. **Fix unsubscribe regex in `automation-executor`** to match the newsletter-safe version
8. **Fix the `from`/`to` variable ordering bug** in `gmail-sync` (lines 1021 vs 1048)
9. **Create `useOutlookSync` hook** or unify into a provider-agnostic `useMailSync` hook

### Phase 3: Unified Architecture (Future)

10. **Extract shared sync logic** (`deriveStage`, `deriveAction`, safeguards) into `_shared/syncEngine.ts` so both Gmail and Outlook sync functions use identical business logic
11. **Unify the automation pipeline** to be fully provider-agnostic via `MailProviderRouter`

---

## Summary Table

| Feature | Gmail | Outlook | Gap Severity |
|---|---|---|---|
| Email sync (pull history) | Full | None | CRITICAL |
| Interaction recording | Yes | No | CRITICAL |
| Automation send pipeline | Yes | No | CRITICAL |
| Post-send state updates | Yes | No | CRITICAL |
| Stage derivation | Yes | No | CRITICAL |
| Action/cadence scheduling | Yes | No | CRITICAL |
| Direct-conversation filter | Yes | No | HIGH |
| Newsletter guard | Yes | No | HIGH |
| Bounce detection | Yes | No | HIGH |
| OOO detection | Yes | No | HIGH |
| Unsubscribe detection | Yes (fixed) | No | MEDIUM |
| 404 thread retry | Yes | No | MEDIUM |
| Reconnect prompt | Yes | No | MEDIUM |
| Frontend sync hook | Yes | No | MEDIUM |

