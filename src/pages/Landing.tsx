import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Mail, Zap, PenTool } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";

const features = [
  {
    icon: Mail,
    title: "Email Automation",
    description: "Automate outreach sequences and follow-ups so no lead slips through the cracks.",
  },
  {
    icon: Zap,
    title: "Workflow Management",
    description: "Track deal stages, set cadences, and manage your pipeline from one dashboard.",
  },
  {
    icon: PenTool,
    title: "AI Drafting",
    description: "Generate personalized email drafts powered by AI that match your tone and context.",
  },
];

export default function Landing() {
  const { user, profile, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading || !user) return;
    if (profile?.onboarding_done) {
      navigate("/app", { replace: true });
    } else {
      navigate("/onboarding", { replace: true });
    }
  }, [isLoading, user, profile?.onboarding_done, navigate]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-6 py-4">
          <span className="text-lg font-bold tracking-tight">DrivePilot</span>
          <div className="flex items-center gap-3">
            {user ? (
              <Button size="sm" asChild>
                <Link to="/app">Go to Dashboard</Link>
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/auth">Sign In</Link>
                </Button>
                <Button size="sm" asChild>
                  <Link to="/auth">Get Started</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1">
        <section className="max-w-3xl mx-auto px-6 pt-24 pb-16 text-center">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-tight mb-4">
            DrivePilot
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto mb-10">
            AI-powered email automation platform for professionals.
          </p>
          <Button size="lg" asChild>
            <Link to="/auth">Start Free</Link>
          </Button>
        </section>

        {/* Features */}
        <section className="max-w-4xl mx-auto px-6 pb-24">
          <div className="grid gap-8 sm:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="space-y-3">
                <div className="inline-flex items-center justify-center h-10 w-10 rounded-md bg-primary/10">
                  <f.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="max-w-5xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <span>© {new Date().getFullYear()} DrivePilot</span>
          <div className="flex items-center gap-4">
            <a href="mailto:support@drivepilot.app" className="hover:text-foreground">
              support@drivepilot.app
            </a>
            <Link to="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link to="/terms" className="hover:text-foreground">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
