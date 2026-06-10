// ============================================================================
// OutreachCard — a single cold campaign touch in the Queue's "Outreach" tab.
//
// Same card shape as QueueCard (nothing new to learn), but ONE loud primary
// action per channel. Manual touches (call/SMS/WhatsApp/LinkedIn) go out through
// the rep's own phone/apps — we can't confirm the send, so we never auto-mark it:
// after the deep-link opens, one quiet "Sent it" closes the touch and advances.
// Email touches in review mode show a "Send" that approves + sends through the
// shared sender (the outreach-touch-action edge function). Plain sales language
// only — no channel jargon on screen.
// ============================================================================

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Phone, MessageSquare, Send, Loader2, Linkedin } from "lucide-react";
import { toast } from "sonner";
import type { OutreachTouch } from "@/lib/outreachQueue";
import { sendReviewEmail, markTouchSent, skipTouch, setCallOutcome } from "@/lib/outreachQueue";
import { telLink, smsLink, whatsappLink, copyToClipboard } from "@/lib/outreachDeepLinks";
import { useIsMobile } from "@/hooks/use-mobile";
import { useBrowserCall } from "@/components/call/BrowserCallProvider";
import { fetchRepCallerNumber } from "@/lib/repCallerNumber";

interface OutreachCardProps {
  touch: OutreachTouch;
  /** Called after the touch is completed/skipped so the parent removes the card. */
  onDone: (touchId: string) => void;
  /** Restore the card if the action failed. */
  onRestore: (touchId: string) => void;
}

export function OutreachCard({ touch, onDone, onRestore }: OutreachCardProps) {
  const [opened, setOpened] = useState(false); // rep has tapped the channel action
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [subject, setSubject] = useState(touch.subject || "");
  const [body, setBody] = useState(touch.body || "");

  // Device-aware calling: on a computer the Call button dials in the browser
  // (reusing the same Twilio browser-call engine as Lead Detail); on a phone it
  // opens the native dialer (tel:), exactly as before. The Queue already sits
  // inside <BrowserCallProvider> (App.tsx), so no extra wiring is needed.
  const isMobile = useIsMobile();
  const { makeCall, status: callStatus, leadId: activeCallLeadId, activeCall } = useBrowserCall();
  const [callPrep, setCallPrep] = useState(false);       // resolving caller ID
  const [callConfirmOpen, setCallConfirmOpen] = useState(false);
  const [callerId, setCallerId] = useState<string | null>(null);
  const callInProgress = callStatus === "connecting" || callStatus === "on-call";

  // Reveal the outcome buttons only once a real call OBJECT exists for THIS lead.
  // The provider sets `activeCall` ONLY after `device.connect()` resolves (i.e.
  // the call is actually placed/ringing), and nulls it on every failure path.
  // Gating on the object — not on `status === "connecting"` — is what makes this
  // correct: makeCall sets "connecting" BEFORE awaiting connect(), so an invalid
  // number, an unready device, or a rejected connection never produces a call
  // object and therefore never reveals the outcome controls (no marking a
  // non-existent call as done). A dial that rings-but-isn't-answered DOES create
  // the object first, so the "No answer" path still works. Latch-only, so the
  // buttons persist after the call ends for outcome capture.
  const callPlacedForThisLead = !!activeCall && activeCallLeadId === touch.leadId;
  useEffect(() => {
    if (callPlacedForThisLead) setOpened(true);
  }, [callPlacedForThisLead]);

  const first = touch.leadName.split(" ")[0] || touch.leadName;

  // True when the sender resolved content for this (campaign, step, industry). When the
  // resolver returns nothing (no industry match and no General variant) ALL of these are
  // null, and NO channel should be actionable — email would open an empty compose, and a
  // manual step (SMS/WhatsApp/LinkedIn/voice) would deep-link a blank message and let the
  // rep mark it sent. Gate every channel on this so a missing-content touch is Skip-only.
  const hasContent = !!(
    touch.subject || touch.body || touch.smsText || touch.talkingPoints || touch.voicemailScript
  );

  // ── Action runners (optimistic: parent removes the card) ──
  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, successMsg: string) {
    setBusy(true);
    onDone(touch.id); // optimistic — card leaves the Queue
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      onRestore(touch.id);
      toast.error(res.error || "Something went wrong");
      return;
    }
    toast.success(successMsg);
  }

  const handleSentIt = () => run(() => markTouchSent(touch.id), "Marked as sent");
  const handleSkip = () => run(() => skipTouch(touch.id), "Skipped");

  async function recordOutcome(outcome: "got_them" | "no_answer") {
    await setCallOutcome(touch.id, outcome); // best-effort; shapes the next draft
    toast.success(outcome === "got_them" ? "Noted: reached them" : "Noted: no answer");
  }

  async function handleReviewSend() {
    setBusy(true);
    setReviewOpen(false);
    onDone(touch.id);
    const res = await sendReviewEmail(touch.id, subject.trim(), body.trim());
    setBusy(false);
    if (!res.ok) {
      onRestore(touch.id);
      toast.error(res.error || "Couldn't send");
      return;
    }
    toast.success("Sent");
  }

  // ── Calling (device-aware) ──
  // Desktop → browser call (with a quick confirm); mobile → native dialer.
  // Either way, the same "Got them / No answer / Sent it" buttons appear next,
  // so outcome capture and cadence advance are identical across devices.
  async function prepareDesktopCall() {
    const phone = touch.phone;
    if (!phone) return;
    setCallPrep(true);
    const from = await fetchRepCallerNumber().catch(() => null);
    setCallPrep(false);
    if (from) {
      setCallerId(from);
      setCallConfirmOpen(true);
      return;
    }
    // Calling-in-the-app isn't set up for this rep/workspace → fall back to the
    // phone dialer so the rep is never blocked. Plain wording, no "browser/dialer".
    toast.info("Opening your phone to make the call.");
    setOpened(true);
    window.location.href = telLink(phone);
  }

  async function startDesktopCall() {
    setCallConfirmOpen(false);
    const phone = touch.phone;
    if (!callerId || !phone) return;
    try {
      // Don't reveal the outcome state here — the effect above flips it only once
      // the call actually reaches "connecting" for this lead, so a number that
      // never dials can't leave the rep marking a non-existent call as done.
      await makeCall({
        toNumber: phone,
        fromNumber: callerId,
        leadId: touch.leadId,
        leadName: touch.leadName,
      });
    } catch {
      toast.error("Couldn't start the call");
    }
  }

  // ── Primary action per channel ──
  function openChannelApp() {
    // Voice on a computer takes the browser-call path (confirm dialog first), so
    // don't flip `opened` yet — a cancelled confirm must leave the Call button.
    if (touch.channel === "voice" && touch.phone && !isMobile) {
      void prepareDesktopCall();
      return;
    }
    setOpened(true);
    if (touch.channel === "voice" && touch.phone) {
      window.location.href = telLink(touch.phone); // mobile → native dialer
    } else if (touch.channel === "sms" && touch.phone) {
      window.location.href = smsLink(touch.phone, touch.smsText || touch.body || "");
    } else if (touch.channel === "whatsapp" && (touch.whatsappNumber || touch.phone)) {
      window.open(whatsappLink((touch.whatsappNumber || touch.phone)!, touch.smsText || touch.body || ""), "_blank", "noopener,noreferrer");
    } else if (touch.channel === "linkedin" && touch.linkedinUrl) {
      // Copy the prepared message silently, then open the profile to paste + send.
      void copyToClipboard(touch.body || touch.talkingPoints || "").then((ok) => {
        if (ok) toast.success("Message copied — paste it in LinkedIn");
      });
      window.open(touch.linkedinUrl, "_blank", "noopener,noreferrer");
    }
  }

  const channelMeta: Record<string, { label: string; icon: ReactNode }> = {
    voice: { label: "Call", icon: <Phone className="mr-1.5 h-4 w-4" /> },
    sms: { label: "Text", icon: <MessageSquare className="mr-1.5 h-4 w-4" /> },
    whatsapp: { label: "WhatsApp", icon: <MessageSquare className="mr-1.5 h-4 w-4" /> },
    linkedin: { label: "Open LinkedIn", icon: <Linkedin className="mr-1.5 h-4 w-4" /> },
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3 transition-colors hover:bg-card/80">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{touch.leadName}</span>
            <Badge variant="secondary" className="shrink-0 text-[10px]">{touch.campaignName}</Badge>
          </div>
          <div className="truncate text-xs text-muted-foreground">{touch.company || "—"}</div>
          {touch.channel === "voice" && opened && touch.talkingPoints && (
            <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{touch.talkingPoints}</p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {!hasContent ? (
            // No content resolved for this lead's industry (and no General variant) — the
            // sender would refuse it, so no channel is actionable; the rep can Skip.
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled
              title="No content for this lead's industry yet — add a General variant or this industry's copy in the campaign.">
              No content
            </Button>
          ) : touch.channel === "email" ? (
            <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => setReviewOpen(true)}>
              <Send className="mr-1.5 h-4 w-4" /> Send
            </Button>
          ) : !opened ? (
            // Only the voice button reflects browser-call state; callInProgress is
            // app-wide, so it must NOT disable SMS/WhatsApp/LinkedIn actions.
            (() => {
              const voiceBusy = touch.channel === "voice" && (callPrep || callInProgress);
              return (
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  disabled={busy || voiceBusy}
                  onClick={openChannelApp}
                >
                  {voiceBusy ? (
                    <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{callInProgress ? "In call" : "Connecting…"}</>
                  ) : (
                    <>{channelMeta[touch.channel]?.icon}{channelMeta[touch.channel]?.label}</>
                  )}
                </Button>
              );
            })()
          ) : (
            <div className="flex flex-col items-end gap-1.5">
              {touch.channel === "voice" && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => recordOutcome("got_them")}>Got them</Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => recordOutcome("no_answer")}>No answer</Button>
                </div>
              )}
              <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={handleSentIt}>
                {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />} Sent it
              </Button>
            </div>
          )}
          <Button size="sm" variant="ghost" className="h-7 text-[11px] text-muted-foreground" disabled={busy} onClick={handleSkip}>
            Skip
          </Button>
        </div>
      </div>

      {/* Review-mode email preview + send */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Send to {first}</DialogTitle>
            <DialogDescription>Review and edit before it goes out.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} placeholder="Email body" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReviewOpen(false)}>Cancel</Button>
            <Button disabled={busy || !subject.trim() || !body.trim()} onClick={handleReviewSend}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Desktop browser-call confirm (mic + caller ID). Mobile skips this and
          dials the native phone app directly. */}
      <AlertDialog open={callConfirmOpen} onOpenChange={setCallConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Call {first}?</AlertDialogTitle>
            <AlertDialogDescription>
              Your browser will connect to <strong>{touch.phone}</strong>
              {callerId ? <> using caller ID <strong>{callerId}</strong></> : null}.
              <br />
              Make sure your microphone is on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={startDesktopCall}>
              <Phone className="mr-1.5 h-4 w-4" /> Start call
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
