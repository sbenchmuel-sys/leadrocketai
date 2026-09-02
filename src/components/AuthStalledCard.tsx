// Shown instead of the bare spinner when the initial auth/profile load has been
// running for too long (see AuthContext.authStalled). Supabase's auth client can
// wait forever on a stuck cross-tab lock or a pending token refresh — without this
// the app is a blank page with no way out (BUG-014).
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Hard reset: drop the cached Supabase session (keys are `sb-<ref>-auth-token`)
 *  without going through the auth client — which may be the thing that's stuck. */
export function clearLocalSessionAndGoToSignIn() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("sb-")) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable — still navigate */ }
  window.location.assign("/auth");
}

export function AuthStalledCard() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle>Taking longer than usual</CardTitle>
          <CardDescription>
            We’re still signing you in. Reloading usually fixes this. If it keeps happening, sign in again.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button onClick={() => window.location.reload()} className="flex-1">Reload</Button>
          <Button variant="outline" onClick={clearLocalSessionAndGoToSignIn} className="flex-1">Sign in again</Button>
        </CardContent>
      </Card>
    </div>
  );
}
