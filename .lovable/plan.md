## The bug

The New Outreach form isn't actually "refreshing the page" — the app is unmounting and remounting the route, which wipes local React state (form fields, selected channel, etc.).

Root cause is in `src/contexts/AuthContext.tsx` (lines 50–57). On **every** Supabase auth event of type `SIGNED_IN` *or* `TOKEN_REFRESHED`, the code does:

```ts
setIsLoading(true);
setTimeout(() => loadProfileForUser(), 0);
```

Flipping `isLoading` back to `true` causes `ProtectedRoute` (and `ProtectedOnboardingRoute`) to render the full-screen spinner instead of `<Outlet/>`. That unmounts `NewCampaign`, throwing away all its `useState` values. When the profile finishes loading a moment later, `NewCampaign` remounts fresh — looking exactly like a page refresh.

Supabase fires `TOKEN_REFRESHED` automatically (~every hour, on tab focus after expiry, on `getSession()` when the token is near expiry, etc.), which is why it feels random and "automatic."

## The fix

In `src/contexts/AuthContext.tsx`, treat `TOKEN_REFRESHED` as a silent event:

1. Update session/user state (already happens above the branch — keep it).
2. Do **not** call `setIsLoading(true)`.
3. Do **not** re-fetch the profile. The profile doesn't change when a JWT is rotated; we already loaded it on `SIGNED_IN` / initial load. (If we ever need to refresh it, callers use `refreshProfile()` explicitly.)

So the branch becomes:

- `SIGNED_IN` → keep current behavior (set loading, fetch profile via setTimeout).
- `TOKEN_REFRESHED` → just update session/user, leave `isLoading` and `profile` alone.
- `SIGNED_OUT` (no session) → already handled above.

That's a ~5-line change, scoped entirely to `AuthContext.tsx`. No other files need to change.

## Why this is safe

- The Supabase JS client rotates the access token in `session` automatically; downstream `supabase.from(...)` calls pick up the new token from the client, not from our React state. We just need our `session`/`user` refs to stay current for components that read them (which the `setSession`/`setUser` calls at the top of the handler already do).
- `ProtectedRoute` only gates on `user` + `isLoading` + `profile` — none of which legitimately change on a token refresh — so it will stop unmounting routes mid-session.
- Form state in `NewCampaign` (and any other in-progress page) is preserved across token refreshes.

## Verification

After the change:
1. Open `/app/automations/new`, fill in name + offer.
2. In DevTools console, run `await supabase.auth.refreshSession()` to force a `TOKEN_REFRESHED` event.
3. Confirm the form stays mounted and values are intact (previously it would blank).
