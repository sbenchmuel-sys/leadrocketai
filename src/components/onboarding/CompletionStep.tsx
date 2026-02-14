import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { finishOnboarding } from "@/lib/supabaseQueries";
import { toast } from "sonner";
import { Loader2, CheckCircle2, Rocket } from "lucide-react";

interface CompletionStepProps {
  onComplete: () => void;
}

export default function CompletionStep({ onComplete }: CompletionStepProps) {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);

  const handleFinish = async () => {
    setIsLoading(true);
    try {
      await finishOnboarding();
      onComplete();
      toast.success("Welcome aboard!");
      navigate("/app", { replace: true });
    } catch (err) {
      console.error("Failed to finish onboarding:", err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center text-center space-y-8">
      <div className="space-y-5">
        {/* Radial glow behind icon */}
        <div className="relative mx-auto w-24 h-24 flex items-center justify-center">
          <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,hsl(160_84%_39%/0.25)_0%,transparent_70%)]" />
          <div className="relative h-20 w-20 rounded-full bg-success/15 flex items-center justify-center">
            <CheckCircle2 className="h-10 w-10 text-success" />
          </div>
        </div>
        <h2 className="text-3xl font-semibold text-foreground tracking-tight">You're All Set!</h2>
        <p className="text-muted-foreground max-w-md text-[15px] leading-relaxed">
          Your AI assistant is configured and ready to help you close deals faster.
        </p>
      </div>

      <div className="w-full max-w-sm space-y-5">
        <div className="p-5 rounded-2xl bg-muted/30 border border-border text-left">
          <p className="font-medium text-foreground mb-3">What's next:</p>
          <ul className="space-y-2.5 text-sm text-muted-foreground">
            <li className="flex items-start gap-2.5">
              <span className="text-primary font-bold">1.</span>
              View your lead and log your first interaction
            </li>
            <li className="flex items-start gap-2.5">
              <span className="text-primary font-bold">2.</span>
              Generate AI-powered email or LinkedIn drafts
            </li>
            <li className="flex items-start gap-2.5">
              <span className="text-primary font-bold">3.</span>
              Add more knowledge to improve AI quality
            </li>
          </ul>
        </div>

        <Button
          size="lg"
          onClick={handleFinish}
          disabled={isLoading}
          className="w-full h-13 text-[15px] font-medium gap-2"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Rocket className="h-4 w-4" />
          )}
          Launch Your Command Center
        </Button>
      </div>
    </div>
  );
}
