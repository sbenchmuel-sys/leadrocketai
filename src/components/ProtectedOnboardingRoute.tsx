import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

export default function ProtectedOnboardingRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, profile } = useAuth();

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

  // Already completed onboarding -> go to dashboard
  if (profile?.onboarding_done) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
