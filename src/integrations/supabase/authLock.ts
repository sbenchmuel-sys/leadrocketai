// ============================================================================
// authLock — why the app used to hang on the spinner, and the fix (BUG-014 root cause).
//
// supabase-js serialises every auth operation across ALL open tabs with a
// `navigator.locks` lock, and `getSession()` waits for it with NO timeout
// (`_acquireLock(-1)`). Whichever tab holds the lock holds it for as long as
// its own auth request takes — and that request has no timeout either. So one
// background tab whose token refresh hung (laptop lid closed mid-refresh, a
// dead connection, a tab the browser froze) held the lock forever, and every
// other tab sat on the loading spinner forever with `/auth/v1/token` and
// `/auth/v1/user` "pending". The 10s AuthStalledCard was the fallback; this is
// the cause.
//
// Two bounded pieces, both plain createClient options:
//   boundedAuthLock — wait a bounded time for the cross-tab lock, then STEAL it
//     (a lock held longer than that is a dead holder, not a busy one). Stealing
//     from a live refresh at worst double-refreshes, which Supabase tolerates
//     inside its refresh-token reuse window.
//   authFetchWithTimeout — abort any AUTH request (/auth/v1/*) that hasn't
//     answered in AUTH_FETCH_TIMEOUT_MS, so a holder can't wedge the lock in
//     the first place. Wired as global.fetch (supabase-js has no auth-only hook);
//     every other request passes straight through.
// ============================================================================

import { navigatorLock } from "@supabase/supabase-js";

/** How long a tab waits for the cross-tab auth lock before taking it over. */
export const AUTH_LOCK_TIMEOUT_MS = 10_000;
/** How long one auth HTTP request (token refresh, getUser, …) may take. */
export const AUTH_FETCH_TIMEOUT_MS = 15_000;

type LockFn = <R>(name: string, acquireTimeout: number, fn: () => Promise<R>) => Promise<R>;

/**
 * supabase-js `auth.lock`: its own navigatorLock, but "wait forever" (-1) becomes
 * "wait AUTH_LOCK_TIMEOUT_MS, then steal". Non-negative timeouts are passed
 * through untouched (the library uses 0 for its own try-if-free paths).
 * Environments without navigator.locks (tests, SSR) fall through to the
 * library's own fallback behaviour inside navigatorLock.
 */
export const boundedAuthLock: LockFn = async (name, acquireTimeout, fn) => {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  // Same rule the library applies when choosing its default: no Web Locks API
  // (jsdom, old WebViews) → nothing to serialise against, just run.
  if (!locks) return fn();
  if (acquireTimeout >= 0) return navigatorLock(name, acquireTimeout, fn);
  try {
    return await navigatorLock(name, AUTH_LOCK_TIMEOUT_MS, fn);
  } catch (err) {
    if (!(err as { isAcquireTimeout?: boolean })?.isAcquireTimeout) throw err;
    console.warn(`[auth] cross-tab auth lock held for >${AUTH_LOCK_TIMEOUT_MS}ms — taking it over (dead holder).`);
    return locks.request(name, { steal: true }, () => fn());
  }
};

/**
 * supabase-js `global.fetch` (the only fetch hook it exposes — auth has no
 * separate one): the platform fetch, with a deadline on AUTH requests only.
 * Data / edge-function calls are untouched — some legitimately run long
 * (ai_task), and none of them hold the cross-tab lock.
 */
export const authFetchWithTimeout: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/auth/v1/")) return fetch(input, init);
  const deadline = AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS);
  // Honour a caller's own signal too (either one aborting aborts the request).
  const signal = init?.signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([init.signal, deadline])
    : (init?.signal ?? deadline);
  return fetch(input, { ...init, signal });
};
