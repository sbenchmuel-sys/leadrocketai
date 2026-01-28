

# Plan: Add OAuth Token Encryption for Gmail Connections

## Overview
This plan implements end-to-end encryption for Gmail OAuth tokens stored in the `gmail_connections` table. Tokens will be encrypted using AES-256-GCM before storage and decrypted only when needed to call Gmail APIs.

## Why This Matters
Currently, OAuth tokens are stored in plaintext. If an attacker compromises a user account, they could extract these tokens and access the user's Gmail indefinitely. Encrypting tokens at rest adds a critical security layer.

---

## Implementation Steps

### Step 1: Add the TOKEN_ENCRYPTION_KEY Secret
Request you to input your generated encryption key as a secret in the backend environment.

### Step 2: Update `gmail-callback` (Token Storage)
When Google returns tokens after OAuth flow, encrypt both `access_token` and `refresh_token` before storing:

```text
gmail-callback/index.ts changes:
├── Import encryptToken from _shared/encryption.ts
├── Encrypt access_token before storage
├── Encrypt refresh_token before storage
└── Store encrypted values in gmail_connections table
```

### Step 3: Update `gmail-sync` (Token Usage)
When syncing emails, decrypt tokens before using them with Gmail API:

```text
gmail-sync/index.ts changes:
├── Import safeDecryptToken from _shared/encryption.ts
├── Decrypt access_token when fetched from database
├── Decrypt refresh_token when needed for refresh
├── Encrypt new access_token when storing after refresh
└── Use decrypted tokens for Gmail API calls
```

### Step 4: Update `gmail-send` (Token Usage)
When sending emails, decrypt tokens before using them:

```text
gmail-send/index.ts changes:
├── Import safeDecryptToken, encryptToken from _shared/encryption.ts
├── Decrypt tokens when fetched from database
├── Encrypt new access_token when storing after refresh
└── Use decrypted tokens for Gmail API calls
```

### Step 5: Update `gmail-bulk-sync` (Token Usage)
Similar to gmail-sync, decrypt tokens for bulk operations:

```text
gmail-bulk-sync/index.ts changes:
├── Import safeDecryptToken, encryptToken from _shared/encryption.ts
├── Decrypt tokens when fetched from database
├── Encrypt new access_token when storing after refresh
└── Use decrypted tokens for Gmail API calls
```

### Step 6: Deploy Updated Functions
All four edge functions will be redeployed with encryption support.

---

## Technical Details

### Encryption Method
- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Derivation**: SHA-256 hash of TOKEN_ENCRYPTION_KEY
- **Storage Format**: Base64(IV + Ciphertext + AuthTag)

### Backwards Compatibility
The `safeDecryptToken()` function handles migration gracefully:
- If TOKEN_ENCRYPTION_KEY is not set → returns token as-is (plaintext)
- If token doesn't look encrypted → returns as-is (legacy token)
- If decryption fails → falls back to treating as plaintext

This means:
1. Existing plaintext tokens continue to work
2. New/refreshed tokens get encrypted automatically
3. Over time, all tokens become encrypted

### Token Refresh Flow
When tokens are refreshed:
1. Decrypt stored refresh_token
2. Call Google OAuth to get new access_token
3. Encrypt new access_token
4. Store encrypted access_token in database

---

## Files to Modify

| File | Changes |
|------|---------|
| `supabase/functions/gmail-callback/index.ts` | Encrypt tokens on initial OAuth completion |
| `supabase/functions/gmail-sync/index.ts` | Decrypt tokens for API calls, encrypt on refresh |
| `supabase/functions/gmail-send/index.ts` | Decrypt tokens for API calls, encrypt on refresh |
| `supabase/functions/gmail-bulk-sync/index.ts` | Decrypt tokens for API calls, encrypt on refresh |

---

## Testing
After implementation:
1. Reconnect Gmail to store newly encrypted tokens
2. Verify email sync still works
3. Verify email sending still works
4. Check database to confirm tokens are now encrypted (long base64 strings)

