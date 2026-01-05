import { useAuth } from "@/contexts/AuthContext";
import { useLocation } from "react-router-dom";

export function AuthDebugPanel() {
  // Only render in development
  if (!import.meta.env.DEV) return null;

  const { user, session, isLoading, profile } = useAuth();
  const location = useLocation();

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-background border border-border rounded-lg shadow-lg p-3 text-xs max-w-xs opacity-80 hover:opacity-100 transition-opacity">
      <div className="font-semibold mb-2 text-foreground">Auth Debug</div>
      <div className="space-y-1 text-muted-foreground">
        <div><span className="font-medium">Route:</span> {location.pathname}</div>
        <div><span className="font-medium">Loading:</span> {isLoading ? "true" : "false"}</div>
        <div><span className="font-medium">User:</span> {user?.email ?? "null"}</div>
        <div><span className="font-medium">Session:</span> {session ? "active" : "null"}</div>
        <div><span className="font-medium">Profile:</span> {profile ? JSON.stringify(profile) : "null"}</div>
      </div>
    </div>
  );
}
