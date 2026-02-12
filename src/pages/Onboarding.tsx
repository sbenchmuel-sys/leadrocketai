import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { getCurrentProfile } from "@/lib/supabaseQueries";
import ChoosePlaybookStep from "@/components/onboarding/ChoosePlaybookStep";
import WelcomeStep from "@/components/onboarding/WelcomeStep";
import CreateLeadStep from "@/components/onboarding/CreateLeadStep";
import AddKnowledgeStep from "@/components/onboarding/AddKnowledgeStep";
import CompletionStep from "@/components/onboarding/CompletionStep";

const TOTAL_STEPS = 5;

export default function Onboarding() {
  const navigate = useNavigate();
  const { refreshProfile } = useAuth();
  const [currentStep, setCurrentStep] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadProgress = async () => {
      try {
        const profile = await getCurrentProfile();
        if (profile.onboarding_done) {
          navigate("/dashboard", { replace: true });
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
      <div className="p-4 border-b border-border">
        <div className="max-w-md mx-auto">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-muted-foreground">
              Step {currentStep + 1} of {TOTAL_STEPS}
            </span>
            <span className="text-sm font-medium text-foreground">
              {Math.round(((currentStep + 1) / TOTAL_STEPS) * 100)}%
            </span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${((currentStep + 1) / TOTAL_STEPS) * 100}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {currentStep === 0 && (
            <ChoosePlaybookStep onNext={() => setCurrentStep(1)} />
          )}
          {currentStep === 1 && (
            <WelcomeStep onNext={() => setCurrentStep(2)} />
          )}
          {currentStep === 2 && (
            <CreateLeadStep
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && (
            <AddKnowledgeStep
              onNext={() => setCurrentStep(4)}
              onBack={() => setCurrentStep(2)}
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
