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
import Queue from "./pages/Queue";
import Inbox from "./pages/Inbox";
import Leads from "./pages/Leads";
import Automations from "./pages/Automations";
import NewCampaign from "./pages/NewCampaign";
import CampaignDetail from "./pages/CampaignDetail";
import LeadDetail from "./pages/LeadDetail";
import ContactDetail from "./pages/ContactDetail";
import Knowledge from "./pages/Knowledge";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import ManagerAnalytics from "./pages/ManagerAnalytics";
import CallDetail from "./pages/CallDetail";
import NotFound from "./pages/NotFound";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import ResetPassword from "./pages/ResetPassword";
import { flags } from "@/lib/featureFlags";
import { lazy, Suspense } from "react";

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
