import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/contexts/AuthContext";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BrowserCallProvider } from "@/components/call/BrowserCallProvider";
import { ActiveCallBar } from "@/components/call/ActiveCallBar";
import ProtectedRoute from "@/components/ProtectedRoute";
import ProtectedOnboardingRoute from "@/components/ProtectedOnboardingRoute";
import DashboardLayout from "@/components/DashboardLayout";
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";
import { flags } from "@/lib/featureFlags";
import { lazy, Suspense, type ComponentType } from "react";

// Each page downloads on first visit instead of one ~2 MB bundle up front.
// After a deploy, an open tab may ask for a chunk that no longer exists
// ("Failed to fetch dynamically imported module") — reload once to pick up the
// new build instead of showing the error screen. The flag stops a reload loop.
const CHUNK_RELOAD_FLAG = "chunk-reload-attempted";
const page = (load: () => Promise<{ default: ComponentType }>) =>
  lazy(() =>
    load().then(
      (m) => { try { sessionStorage.removeItem(CHUNK_RELOAD_FLAG); } catch { /* ignore */ } return m; },
      (err) => {
        let tried = true;
        try { tried = !!sessionStorage.getItem(CHUNK_RELOAD_FLAG); sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1"); } catch { /* ignore */ }
        if (tried) throw err;
        window.location.reload();
        return new Promise<never>(() => {});
      },
    ),
  );

const Queue = page(() => import("./pages/Queue"));
const Inbox = page(() => import("./pages/Inbox"));
const Leads = page(() => import("./pages/Leads"));
const Automations = page(() => import("./pages/Automations"));
const NewCampaign = page(() => import("./pages/NewCampaign"));
const CampaignDetail = page(() => import("./pages/CampaignDetail"));
const LeadDetail = page(() => import("./pages/LeadDetail"));
const ContactDetail = page(() => import("./pages/ContactDetail"));
const Knowledge = page(() => import("./pages/Knowledge"));
const Settings = page(() => import("./pages/Settings"));
const Onboarding = page(() => import("./pages/Onboarding"));
const ManagerAnalytics = page(() => import("./pages/ManagerAnalytics"));
const Pilot = page(() => import("./pages/Pilot"));
const CallDetail = page(() => import("./pages/CallDetail"));
const Privacy = page(() => import("./pages/Privacy"));
const Terms = page(() => import("./pages/Terms"));
const ResetPassword = page(() => import("./pages/ResetPassword"));

const DevSmokeTests = lazy(() => import("./pages/DevSmokeTests"));

const queryClient = new QueryClient();

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem
        storageKey="drivepilot-theme"
        disableTransitionOnChange
      >
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
            <AuthProvider>
            <WorkspaceProvider>
            <BrowserCallProvider>
            <ActiveCallBar />
            <Suspense fallback={null}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/auth" element={<Auth />} />
              <Route
                path="/onboarding"
                element={
                  <ProtectedOnboardingRoute>
                    <Onboarding />
                  </ProtectedOnboardingRoute>
                }
              />
              <Route
                path="/app"
                element={
                  <ProtectedRoute>
                    <DashboardLayout />
                  </ProtectedRoute>
                }
              >
                {/* PR D: /app/queue is the new default landing page. */}
                <Route index element={<Navigate to="/app/queue" replace />} />
                <Route path="queue" element={<Queue />} />
                {/* Unit A: Dashboard merged into Leads. Old link redirects so
                    bookmarks / deep links don't 404. */}
                <Route path="dashboard" element={<Navigate to="/app/leads" replace />} />
                <Route path="inbox" element={<Inbox />} />
                <Route path="leads" element={<Leads />} />
                <Route path="automations" element={<Automations />} />
                <Route path="automations/new" element={<NewCampaign />} />
                <Route path="automations/:id" element={<CampaignDetail />} />
                <Route path="leads/:id" element={<LeadDetail />} />
                <Route path="lead/:id" element={<LeadDetail />} />
                <Route path="contacts/:id" element={<ContactDetail />} />
                <Route path="knowledge" element={<Knowledge />} />
                <Route path="settings" element={<Settings />} />
                <Route path="analytics" element={<ManagerAnalytics />} />
                <Route path="pilot" element={<Pilot />} />
                <Route path="calls/:callSessionId" element={<CallDetail />} />
                {flags.dev_smoke && (
                  <Route path="dev-smoke" element={<Suspense fallback={null}><DevSmokeTests /></Suspense>} />
                )}
              </Route>
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
            </Suspense>
            </BrowserCallProvider>
            </WorkspaceProvider>
            </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
