import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Users, BookOpen, LayoutDashboard, LogOut, Settings, Inbox, BarChart3, RotateCcw, FlaskConical, ListChecks } from "lucide-react";
import { useEffect, useState } from "react";
import { isDemoMode } from "@/lib/demoMode";
import { supabase } from "@/integrations/supabase/client";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { CalendarReconsentModal } from "@/components/calendar/CalendarReconsentModal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

type NavItem = {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  managerOnly?: boolean;
};

// PR D — Queue is the new default landing page (`/app` redirects to
// `/app/queue`). Dashboard stays in the nav as the one-click escape
// hatch since Phase 1.7's kill switch is deferred. Order matters:
// Queue first (default), Dashboard second.
const navItems: NavItem[] = [
{ to: "/app/queue", icon: ListChecks, label: "Queue" },
{ to: "/app/dashboard", icon: LayoutDashboard, label: "Dashboard" },
{ to: "/app/leads", icon: Users, label: "Leads" },
{ to: "/app/inbox", icon: Inbox, label: "Inbox" },
{ to: "/app/knowledge", icon: BookOpen, label: "Knowledge Base" },
{ to: "/app/settings", icon: Settings, label: "Settings" }];


export default function DashboardLayout() {
  const { signOut, user, refreshProfile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [isManagerOrAdmin, setIsManagerOrAdmin] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // Gmail sync is now server-side via pg_cron. Manual sync available from Settings.
  // useGmailAutoSync() removed — no longer auto-polls from browser.

  useEffect(() => {
    if (!user) return;
    supabase.
    from("workspace_members").
    select("role").
    eq("user_id", user.id).
    maybeSingle().
    then(({ data }) => {
      setIsManagerOrAdmin(data?.role === "admin" || data?.role === "manager");
    });
  }, [user]);

  const handleResetDemo = async () => {
    setIsResetting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await supabase.functions.invoke("reset-demo", {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (res.error) throw res.error;
      await refreshProfile();
      navigate("/onboarding");
      toast.success("Demo reset complete — starting fresh!");
    } catch (err: any) {
      console.error("Reset demo failed:", err);
      toast.error("Failed to reset demo: " + (err.message || String(err)));
    } finally {
      setIsResetting(false);
    }
  };

  const visibleNavItems = navItems.filter(
    (item) => !item.managerOnly || isManagerOrAdmin
  );

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card hidden md:flex flex-col">
        <div className="p-3 border-b border-border">
          <WorkspaceSwitcher />
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {visibleNavItems.map((item) => {
            const isActive = location.pathname === item.to ||
            item.to !== "/app" && location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive ?
                  "bg-primary text-primary-foreground" :
                  "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}>

                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>);

          })}
        </nav>
        <div className="p-4 border-t border-border space-y-2">
          <div className="text-xs text-muted-foreground mb-2 truncate">
            {user?.email}
          </div>
          <Button
            variant={isDemoMode() ? "default" : "outline"}
            size="sm"
            className="w-full"
            onClick={() => {
              const current = isDemoMode();
              if (current) {
                // Remove from localStorage and reload
                localStorage.removeItem("VITE_DEMO_MODE");
              } else {
                localStorage.setItem("VITE_DEMO_MODE", "true");
              }
              window.location.reload();
            }}
          >
            <FlaskConical className="h-4 w-4 mr-2" />
            {isDemoMode() ? "Exit Demo Mode" : "Enter Demo Mode"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full text-destructive hover:text-destructive hover:bg-destructive/10" disabled={isResetting}>
                <RotateCcw className="h-4 w-4 mr-2" />
                {isResetting ? "Resetting..." : "Reset Demo"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset Demo?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently erase all your data — leads, conversations, knowledge base, settings, and integrations. You'll restart from the onboarding flow.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleResetDemo} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Erase Everything & Reset
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button variant="outline" size="sm" onClick={signOut} className="w-full">
            <LogOut className="h-4 w-4 mr-2" />
            Sign Out
          </Button>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-14 border-b border-border bg-card z-50 flex items-center px-4 gap-4">
        <h1 className="font-bold">DrivePilot</h1>
        <nav className="flex-1 flex gap-2 overflow-x-auto">
          {visibleNavItems.map((item) => {
            const isActive = location.pathname === item.to ||
            item.to !== "/app" && location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded text-xs whitespace-nowrap",
                  isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                )}>

                <item.icon className="h-3 w-3" />
                {item.label}
              </Link>);

          })}
        </nav>
        <Button variant="ghost" size="sm" onClick={signOut}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      {/* Main content */}
      <main className="flex-1 md:overflow-auto">
        <div className="md:p-6 p-4 pt-20 md:pt-6">
          <Outlet />
        </div>
      </main>

      <CalendarReconsentModal />
    </div>);

}