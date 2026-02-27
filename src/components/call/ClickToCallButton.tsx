import { useState } from "react";
import { Phone, Loader2, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Link } from "react-router-dom";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

interface ClickToCallButtonProps {
  leadId: string;
  leadName: string;
  leadPhone: string | null;
}

export function ClickToCallButton({ leadId, leadName, leadPhone }: ClickToCallButtonProps) {
  const [isDialing, setIsDialing] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [callResult, setCallResult] = useState<{ callSid: string; callSessionId?: string } | null>(null);
  const [fromNumber, setFromNumber] = useState<string | null>(null);

  if (!leadPhone) return null;

  async function handleCallClick() {
    // Fetch rep's Twilio number
    const { data: repProfile } = await supabase
      .from("rep_profiles")
      .select("twilio_phone_number")
      .limit(1)
      .maybeSingle();

    const repNumber = (repProfile as any)?.twilio_phone_number;
    if (!repNumber) {
      toast.error("No Twilio caller ID configured", {
        description: "Go to Settings → Your Profile to set your Twilio phone number.",
      });
      return;
    }

    setFromNumber(repNumber);
    setShowConfirm(true);
  }

  async function initiateCall() {
    if (!fromNumber || !leadPhone) return;
    setShowConfirm(false);
    setIsDialing(true);
    setCallResult(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/twilio-voice-outbound`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          toNumber: leadPhone,
          fromNumber,
          leadId,
        }),
      });

      const body = await resp.json();

      if (!resp.ok || !body.ok) {
        throw new Error(body.error || body.details || "Call failed");
      }

      setCallResult({ callSid: body.callSid });
      toast.success(`Calling ${leadName}...`, {
        description: `Call SID: ${body.callSid.slice(0, 12)}…`,
      });
    } catch (err: any) {
      toast.error("Failed to initiate call", { description: err.message });
    } finally {
      setIsDialing(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs gap-1.5"
        onClick={handleCallClick}
        disabled={isDialing}
      >
        {isDialing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Phone className="h-3.5 w-3.5" />
        )}
        {isDialing ? "Dialing…" : "Call"}
      </Button>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Call {leadName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Twilio will connect <strong>{fromNumber}</strong> → <strong>{leadPhone}</strong>.
              <br />
              Your phone will ring first, then the lead will be connected.
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
