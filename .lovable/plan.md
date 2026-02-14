

# Fix Google Sign-In Post-Auth Journey

## Problem

After signing in with Google, the OAuth callback redirects to the app's origin (`/`), which is the public Landing page. This page has no authentication awareness, so it always shows "Sign In" — the user appears stuck.

## Root Cause

In `src/pages/Auth.tsx`, the Google sign-in sets `redirect_uri: window.location.origin` (which resolves to `/`). After the OAuth flow completes and the session is established, the browser lands on `/` (Landing page), which never checks auth state.

The Auth page (`/auth`) does have redirect logic that sends authenticated users to `/app`, but the user never reaches `/auth` after the OAuth callback.

## Solution

Make the Landing page auth-aware: if a user arrives at `/` and is already authenticated, redirect them to `/app` (or `/onboarding` if onboarding isn't complete). This mirrors the logic already in `Auth.tsx`.

### File: `src/pages/Landing.tsx`

- Import `useAuth` from the auth context and `useNavigate` from React Router
- Add a `useEffect` that checks if the user is authenticated
  - If authenticated and onboarding done: redirect to `/app`
  - If authenticated and onboarding not done: redirect to `/onboarding`
- Update the header buttons: if the user is logged in (but redirect hasn't fired yet), show "Go to Dashboard" instead of "Sign In"

### File: `src/pages/Auth.tsx` (optional improvement)

- No changes strictly required since the Landing page fix covers the redirect, but consider changing `redirect_uri` to point to `/auth` instead of origin for a cleaner flow (the Auth page already handles post-login routing)

## Technical Details

Changes to `src/pages/Landing.tsx`:

```typescript
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";

export default function Landing() {
  const { user, profile, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading) return;
    if (!user) return;
    if (profile?.onboarding_done) {
      navigate("/app", { replace: true });
    } else {
      navigate("/onboarding", { replace: true });
    }
  }, [isLoading, user, profile?.onboarding_done, navigate]);

  // Update header buttons to show "Dashboard" if signed in
  // ...rest of component
}
```

The header will conditionally render:
- **Signed in**: "Go to Dashboard" button linking to `/app`
- **Not signed in**: "Sign In" and "Get Started" buttons linking to `/auth`

## Files Changed

| File | Change |
|------|--------|
| `src/pages/Landing.tsx` | Add auth check with redirect + conditional header buttons |

