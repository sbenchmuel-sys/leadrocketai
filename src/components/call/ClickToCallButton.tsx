import { useState } from "react";
import { Phone, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBrowserCall } from "./BrowserCallProvider";

interface ClickToCallButtonProps {
  leadId: string;
  leadName: string;
  leadPhone: string | null;
}

export function ClickToCallButton({ leadId, leadName, leadPhone }: ClickToCallButtonProps) {
  const { makeCall, status } = useBrowserCall();
  const [showConfirm, setShowConfirm] = useState(false);
  const [fromNumber, setFromNumber] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  if (!leadPhone) return null;

  const isBusy = status === "connecting" || status === "on-call";

  async function handleCallClick() {
    setIsLoading(true);
    try {
      // Fetch rep's Twilio number
      const { data: repProfile } = await supabase
        .from("rep_profiles")
        .select("twilio_phone_number")
        .limit(1)
        .maybeSingle();

      let repNumber = (repProfile as any)?.twilio_phone_number;

      // Fallback to workspace default
      if (!repNumber) {
        const { data: membership } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .eq("user_id", (await supabase.auth.getUser()).data.user?.id ?? "")
          .limit(1)
          .maybeSingle();

        if (membership?.workspace_id) {
          const { data: callSettings } = await supabase
            .from("call_settings")
            .select("default_twilio_number")
            .eq("workspace_id", membership.workspace_id)
            .maybeSingle();

          repNumber = (callSettings as any)?.default_twilio_number;
        }
      }

      if (!repNumber) {
        toast.error("No Twilio caller ID configured", {
          description: "Set a default in Settings → Calls/Voice, or your own in Settings → Your Profile.",
        });
        return;
      }

      setFromNumber(repNumber);
      setShowConfirm(true);
    } finally {
      setIsLoading(false);
    }
  }

  async function initiateCall() {
    if (!fromNumber || !leadPhone) return;
    setShowConfirm(false);

    await makeCall({
      toNumber: leadPhone,
      fromNumber,
      leadId,
      leadName,
    });
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs gap-1.5"
        onClick={handleCallClick}
        disabled={isBusy || isLoading}
      >
        {isLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Phone className="h-3.5 w-3.5" />
        )}
        {isBusy ? "In Call" : isLoading ? "Loading…" : "Call"}
      </Button>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Call {leadName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Your browser will connect to <strong>{leadPhone}</strong> using caller ID <strong>{fromNumber}</strong>.
              <br />
              Make sure your microphone is enabled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={initiateCall}>
              <Phone className="h-4 w-4 mr-1.5" />
              Start Call
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
