import { Outlet, Link, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Users, BookOpen, LayoutDashboard, LogOut, Settings, Inbox } from "lucide-react";
import { useGmailAutoSync } from "@/hooks/useGmailAutoSync";

const navItems = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/dashboard/inbox", icon: Inbox, label: "Inbox" },
  { to: "/dashboard/leads", icon: Users, label: "Leads" },
  { to: "/dashboard/knowledge", icon: BookOpen, label: "Knowledge Base" },
  { to: "/dashboard/settings", icon: Settings, label: "Settings" },
];

export default function DashboardLayout() {
  const { signOut, user } = useAuth();
  const location = useLocation();

  // Initialize background Gmail auto-sync (every 20 minutes)
  useGmailAutoSync();

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card hidden md:flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-xl font-bold text-foreground">Deal Assistant</h1>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const isActive = location.pathname === item.to || 
              (item.to !== "/dashboard" && location.pathname.startsWith(item.to));
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-border">
          <div className="text-xs text-muted-foreground mb-2 truncate">
            {user?.email}
          </div>
          <Button variant="outline" size="sm" onClick={signOut} className="w-full">
            <LogOut className="h-4 w-4 mr-2" />
            Sign Out
          </Button>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-14 border-b border-border bg-card z-50 flex items-center px-4 gap-4">
        <h1 className="font-bold">Deal Assistant</h1>
        <nav className="flex-1 flex gap-2 overflow-x-auto">
          {navItems.map((item) => {
            const isActive = location.pathname === item.to || 
              (item.to !== "/dashboard" && location.pathname.startsWith(item.to));
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded text-xs whitespace-nowrap",
                  isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                )}
              >
                <item.icon className="h-3 w-3" />
                {item.label}
              </Link>
            );
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
    </div>
  );
}
