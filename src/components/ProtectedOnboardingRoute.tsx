import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ProtectedOnboardingRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, profile, refreshProfile, signOut } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  // Not logged in -> go to auth
  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  // If profile isn't available yet, show a non-blank recovery UI.
  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>Loading your onboarding state</CardTitle>
            <CardDescription>We couldn’t read your profile yet. Try again.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => refreshProfile()} className="flex-1">Retry</Button>
            <Button variant="outline" onClick={() => signOut()} className="flex-1">Sign out</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Already completed onboarding -> land on the app's default page,
  // which is now the Queue (PR D — /app redirects to /app/queue).
  // Explicit path avoids a double-redirect for users coming through
  // onboarding completion.
  if (profile.onboarding_done) {
    return <Navigate to="/app/queue" replace />;
  }

  return <>{children}</>;
}
