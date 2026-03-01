import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Mail, Zap, PenTool, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";

const features = [
  {
    icon: Mail,
    title: "Email Automation",
    description:
      "Build multi-step outreach sequences that adapt in real time. Automatic follow-ups, smart scheduling, and reply detection ensure every lead gets the right message at the right moment — without manual effort.",
    gradient: "from-primary/20 to-primary/5",
  },
  {
    icon: Zap,
    title: "Workflow Management",
    description:
      "Visualize your entire pipeline at a glance. Track deal stages, set custom cadences, and let AI flag stalled opportunities before they go cold — all from a single command center.",
    gradient: "from-secondary/20 to-secondary/5",
  },
  {
    icon: PenTool,
    title: "AI Drafting",
    description:
      "Generate high-converting email and LinkedIn drafts trained on your product knowledge. Every message matches your tone, references real context, and lands with precision.",
    gradient: "from-success/20 to-success/5",
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
        <section className="relative max-w-4xl mx-auto px-6 pt-32 pb-28 text-center overflow-hidden">
          {/* Radial glow */}
          <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-[radial-gradient(ellipse,hsl(217_91%_60%/0.12)_0%,transparent_70%)]" />
          </div>

          <div className="relative z-10 space-y-6">
            <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight leading-[1.1]">
              Your AI Deal Assistant.
            </h1>
            <p className="text-2xl sm:text-3xl font-medium text-muted-foreground tracking-tight leading-snug max-w-2xl mx-auto">
              Close faster. Follow up smarter.
              <br className="hidden sm:block" />
              Never drop a lead.
            </p>
            <p className="text-[16px] text-muted-foreground/80 max-w-xl mx-auto leading-relaxed">
              Automate outreach, manage your pipeline, and draft high-converting emails — all from one command center.
            </p>

            <div className="flex items-center justify-center gap-4 pt-4">
              <Button size="lg" asChild className="h-13 px-8 text-[15px] font-medium gap-2">
                <Link to="/auth">
                  Deploy Your Assistant
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="ghost" asChild className="h-13 px-8 text-[15px] font-medium text-muted-foreground">
                <a href="#features" onClick={(e) => { e.preventDefault(); document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' }); }}>See How It Works</a>
              </Button>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="max-w-5xl mx-auto px-6 pb-32 pt-8">
          <div className="grid gap-10 sm:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="space-y-4">
                <div className={`inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-gradient-to-br ${f.gradient}`}>
                  <f.icon className="h-6 w-6 text-foreground" />
                </div>
                <h3 className="text-lg font-semibold tracking-tight">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <span>© {new Date().getFullYear()} DrivePilot · Shai Benchmuel</span>
          <div className="flex items-center gap-4">
            <a href="mailto:support@drivepilot.app" className="hover:text-foreground transition-colors">
              support@drivepilot.app
            </a>
            <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
