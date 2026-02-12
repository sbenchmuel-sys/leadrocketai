import { Button } from "@/components/ui/button";
import { GmailConnectionCard } from "@/components/gmail/GmailConnectionCard";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { ArrowRight, SkipForward } from "lucide-react";

interface ConnectInboxStepProps {
  onNext: () => void;
  onBack?: () => void;
  allowSkip?: boolean;
}

export default function ConnectInboxStep({ onNext, onBack, allowSkip = true }: ConnectInboxStepProps) {
  const { isConnected } = useGmailConnection();

  return (
    <div className="flex flex-col items-center text-center space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-foreground">Connect Your Inbox</h1>
        <p className="text-muted-foreground max-w-md">
          Link your Gmail so the AI can sync conversations, draft replies, and track engagement automatically.
        </p>
      </div>

      <div className="w-full max-w-sm">
        <GmailConnectionCard onConnectionChange={() => {}} />
      </div>

      <div className="flex flex-col gap-2 w-full max-w-sm">
        {isConnected && (
          <Button size="lg" onClick={onNext} className="w-full gap-2">
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}

        {allowSkip && !isConnected && (
          <Button variant="ghost" size="sm" onClick={onNext} className="text-muted-foreground gap-1.5">
            <SkipForward className="h-4 w-4" />
            Skip for now
          </Button>
        )}

        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="text-muted-foreground">
            Back
          </Button>
        )}
      </div>
    </div>
  );
}
