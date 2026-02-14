

# Account Merging: Email + Google OAuth

## Problem

When a user signs up with email/password and later tries to sign in with Google using the same email, they either get an error or end up with two separate accounts. The app should detect this and guide the user through linking their accounts.

## How It Works

The authentication system supports automatic identity linking when a confirmed email matches. However, if the email isn't confirmed or automatic linking fails, the user sees a cryptic error. We need to handle this gracefully.

## Solution

### 1. Detect duplicate-email errors on Google sign-in

When Google sign-in fails with an error indicating the email is already registered (e.g., "User already registered" or duplicate key errors), catch it and show a friendly merge prompt instead of a generic error toast.

### 2. Add an Account Merge Dialog (`src/components/auth/AccountMergeDialog.tsx`)

A new dialog component that:
- Explains: "An account with this email already exists. Sign in with your password to link your Google account."
- Shows a password input field
- On submit: signs the user in with email/password, then calls `supabase.auth.linkIdentity({ provider: 'google' })` to link the Google identity
- Shows success confirmation when linking completes

### 3. Update Auth page to manage merge flow (`src/pages/Auth.tsx`)

- Add state for `showMergeDialog` and `mergeEmail` (the email from the failed Google attempt)
- In `handleGoogleSignIn`, detect the duplicate-account error and trigger the merge dialog instead of a toast
- After successful merge, redirect normally

### 4. Add "Link Google Account" option in Settings (optional enhancement)

For users already signed in with email/password, add a button in Settings to proactively link their Google account using `linkIdentity`.

## Technical Details

### New file: `src/components/auth/AccountMergeDialog.tsx`

```typescript
// Dialog with:
// - Explanation text about account linking
// - Password input
// - "Link Accounts" button
// - On submit:
//   1. signIn(mergeEmail, password)
//   2. supabase.auth.linkIdentity({ provider: 'google' })
//   3. Close dialog, redirect to /app
```

### Changes to `src/pages/Auth.tsx`

```typescript
// Add state:
const [showMergeDialog, setShowMergeDialog] = useState(false);
const [mergeEmail, setMergeEmail] = useState("");

// In handleGoogleSignIn error handler:
if (error?.message?.includes("already registered") || 
    error?.message?.includes("duplicate")) {
  setMergeEmail(/* extract email from error or context */);
  setShowMergeDialog(true);
} else {
  toast.error(error.message);
}
```

## User Flow

```text
User clicks "Continue with Google"
       |
Google OAuth returns email "user@example.com"
       |
  Email already exists as password account?
       |                    |
      NO                   YES
       |                    |
  Normal sign-in     Show merge dialog
                          |
              User enters password
                          |
              Sign in with password
                          |
              Link Google identity
                          |
              Redirect to /app
```

## Files Changed

| File | Change |
|------|--------|
| `src/components/auth/AccountMergeDialog.tsx` | New dialog for account linking flow |
| `src/pages/Auth.tsx` | Detect duplicate-email error, show merge dialog |

