import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, profile, refreshProfile, signOut } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  // If auth is ready but profile couldn't be loaded, don't redirect-loop.
  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>We couldn’t load your profile</CardTitle>
            <CardDescription>
              This usually means the backend profile record is missing or temporarily unavailable.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => refreshProfile()} className="flex-1">Retry</Button>
            <Button variant="outline" onClick={() => signOut()} className="flex-1">Sign out</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Redirect to onboarding if not completed
  if (!profile.onboarding_done) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
