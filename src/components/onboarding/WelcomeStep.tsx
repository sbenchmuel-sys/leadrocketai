import { Button } from "@/components/ui/button";
import { Sparkles, Target, FileText } from "lucide-react";

interface WelcomeStepProps {
  onNext: () => void;
}

export default function WelcomeStep({ onNext }: WelcomeStepProps) {
  return (
    <div className="flex flex-col items-center text-center space-y-8">
      <div className="space-y-4">
        <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
          <Sparkles className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-3xl font-bold text-foreground">Welcome to Deal Assistant</h1>
        <p className="text-muted-foreground max-w-md">
          Your AI-powered B2B sales companion. Let's get you set up in just 2 minutes.
        </p>
      </div>

      <div className="grid gap-4 text-left w-full max-w-sm">
        <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50">
          <Target className="h-5 w-5 text-primary mt-0.5" />
          <div>
            <p className="font-medium text-foreground">Smart Lead Tracking</p>
            <p className="text-sm text-muted-foreground">AI analyzes your interactions and suggests next steps</p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50">
          <FileText className="h-5 w-5 text-primary mt-0.5" />
          <div>
            <p className="font-medium text-foreground">Draft Generation</p>
            <p className="text-sm text-muted-foreground">Get personalized email and LinkedIn message drafts</p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50">
          <Sparkles className="h-5 w-5 text-primary mt-0.5" />
          <div>
            <p className="font-medium text-foreground">Knowledge-Powered AI</p>
            <p className="text-sm text-muted-foreground">Train the AI with your product info for better results</p>
          </div>
        </div>
      </div>

      <Button size="lg" onClick={onNext} className="w-full max-w-sm">
        Get Started
      </Button>
    </div>
  );
}
