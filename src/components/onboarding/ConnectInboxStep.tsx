import { Button } from "@/components/ui/button";
import { GmailConnectionCard } from "@/components/gmail/GmailConnectionCard";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { ArrowRight, SkipForward, ShieldCheck, Lock, Eye } from "lucide-react";

interface ConnectInboxStepProps {
  onNext: () => void;
  onBack?: () => void;
  allowSkip?: boolean;
}

export default function ConnectInboxStep({ onNext, onBack, allowSkip = true }: ConnectInboxStepProps) {
  const { isConnected } = useGmailConnection();

  return (
    <div className="flex flex-col items-center text-center space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold text-foreground tracking-tight">Connect Your Inbox</h1>
        <p className="text-muted-foreground max-w-md text-[15px] leading-relaxed">
          Link your Gmail so the AI can sync conversations, draft replies, and track engagement automatically.
        </p>
      </div>

      {/* Trust badges */}
      <div className="flex items-center gap-6 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-primary/70" />
          <span>Secure OAuth 2.0</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5 text-primary/70" />
          <span>Enterprise-grade encryption</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5 text-primary/70" />
          <span>Read-only access</span>
        </div>
      </div>

      <div className="w-full max-w-sm">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-lg">
          <GmailConnectionCard onConnectionChange={() => {}} />
        </div>
      </div>

      <div className="flex flex-col gap-2 w-full max-w-sm">
        {isConnected && (
          <Button size="lg" onClick={onNext} className="w-full gap-2 h-12 text-[15px] font-medium">
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
