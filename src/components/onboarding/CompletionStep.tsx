import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { finishOnboarding } from "@/lib/supabaseQueries";
import { toast } from "sonner";
import { Loader2, CheckCircle2, ArrowRight } from "lucide-react";

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
      navigate("/dashboard", { replace: true });
    } catch (err) {
      console.error("Failed to finish onboarding:", err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center text-center space-y-8">
      <div className="space-y-4">
        <div className="h-20 w-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
          <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-400" />
        </div>
        <h2 className="text-2xl font-bold text-foreground">You're All Set!</h2>
        <p className="text-muted-foreground max-w-md">
          You've created your first lead and added knowledge to help the AI write better messages.
        </p>
      </div>

      <div className="w-full max-w-sm space-y-4">
        <div className="p-4 rounded-lg bg-muted/50 text-left">
          <p className="font-medium text-foreground mb-2">What's next:</p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-primary font-bold">1.</span>
              View your lead and log your first interaction
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary font-bold">2.</span>
              Generate AI-powered email or LinkedIn drafts
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary font-bold">3.</span>
              Add more knowledge to improve AI quality
            </li>
          </ul>
        </div>

        <Button size="lg" onClick={handleFinish} disabled={isLoading} className="w-full">
          {isLoading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <ArrowRight className="h-4 w-4 mr-2" />
          )}
          Go to Dashboard
        </Button>
      </div>
    </div>
  );
}
