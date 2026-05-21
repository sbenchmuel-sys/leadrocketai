import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCurrentProfile, setOnboardingStep } from "@/lib/supabaseQueries";
import ChoosePlaybookStep from "@/components/onboarding/ChoosePlaybookStep";
import ConnectInboxStep from "@/components/onboarding/ConnectInboxStep";
import AddKnowledgeStep from "@/components/onboarding/AddKnowledgeStep";
import CreateLeadStep from "@/components/onboarding/CreateLeadStep";
import CompletionStep from "@/components/onboarding/CompletionStep";

const TOTAL_STEPS = 5;

const STEP_LABELS = ["Playbook", "Inbox", "Knowledge", "Leads", "Launch"];

export default function Onboarding() {
  const navigate = useNavigate();
  const { refreshProfile, profile, signOut } = useAuth();
  const [currentStep, setCurrentStep] = useState(0);

  const goToStep = async (step: number) => {
    setCurrentStep(step);
    try { await setOnboardingStep(step); } catch (e) { console.error("Failed to save step:", e); }
  };
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadProgress = async () => {
      try {
        const profile = await getCurrentProfile();
        if (profile.onboarding_done) {
          navigate("/app", { replace: true });
          return;
        }
        setCurrentStep(Math.min(profile.onboarding_step || 0, TOTAL_STEPS - 1));
      } catch (err) {
        console.error("Failed to load onboarding progress:", err);
      } finally {
        setIsLoading(false);
      }
    };
    loadProgress();
  }, [navigate]);

  const handleComplete = async () => {
    await refreshProfile();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Premium progress header */}
      <div className="p-6 border-b border-border">
        <div className="max-w-lg mx-auto space-y-4">
          <div className="flex items-center justify-between">
            {profile?.onboarding_done ? (
              <Button variant="ghost" size="sm" asChild className="text-muted-foreground hover:text-foreground -ml-2">
                <Link to="/app/dashboard">
                  <ArrowLeft className="size-4" />
                  Dashboard
                </Link>
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground -ml-2"
                onClick={async () => {
                  await signOut();
                  navigate("/");
                }}
              >
                <ArrowLeft className="size-4" />
                Home
              </Button>
            )}
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium text-foreground text-sm">
              Step {currentStep + 1} of {TOTAL_STEPS}
            </span>
            <span className="text-sm font-medium text-primary">
              {Math.round(((currentStep + 1) / TOTAL_STEPS) * 100)}%
            </span>
          </div>

          {/* Segmented progress */}
          <div className="flex gap-2">
            {STEP_LABELS.map((label, i) => (
              <div key={label} className="flex-1 space-y-1.5">
                <div
                  className={`h-1.5 rounded-full transition-all duration-500 ${
                    i <= currentStep ? "bg-primary" : "bg-muted"
                  }`}
                />
                <p className={`text-[10px] text-center font-medium transition-colors ${
                  i <= currentStep ? "text-primary" : "text-muted-foreground/50"
                }`}>
                  {label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className={`w-full ${currentStep === 2 ? "max-w-3xl" : "max-w-md"}`}>
          {currentStep === 0 && (
            <ChoosePlaybookStep onNext={() => goToStep(1)} />
          )}
          {currentStep === 1 && (
            <ConnectInboxStep
              onNext={() => goToStep(2)}
              onBack={() => goToStep(0)}
              allowSkip
            />
          )}
          {currentStep === 2 && (
            <AddKnowledgeStep
              onNext={() => goToStep(3)}
              onBack={() => goToStep(1)}
            />
          )}
          {currentStep === 3 && (
            <CreateLeadStep
              onNext={() => goToStep(4)}
              onBack={() => goToStep(2)}
            />
          )}
          {currentStep === 4 && (
            <CompletionStep onComplete={handleComplete} />
          )}
        </div>
      </div>
    </div>
  );
}
