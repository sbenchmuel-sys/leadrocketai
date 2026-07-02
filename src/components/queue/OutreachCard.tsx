// ============================================================================
// OutreachCard — a single cold campaign touch in the Queue's "Outreach" tab.
//
// Action row mirrors QueueCard (Reply/Follow-up tabs): the primary channel action
// on the left, then [Mark as handled] and a [Snooze ▾] dropdown that also carries
// "Skip this step" as its destructive item. Manual channels (call/SMS/WhatsApp/
// LinkedIn) can't be confirmed remotely, so "Mark as handled" is what the rep
// taps after they've done the touch in their own app.
//
// A preview block above the action row shows the copy the rep is about to use
// (talking points, LinkedIn message/note, SMS/WhatsApp text) BEFORE they act —
// no more clicking blindly and trusting the clipboard.
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
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Phone, MessageSquare, Send, Loader2, Linkedin, Check, Clock, Copy } from "lucide-react";
import { toast } from "sonner";
import type { OutreachTouch } from "@/lib/outreachQueue";
import { sendReviewEmail, markTouchSent, skipTouch, snoozeTouch, setCallOutcome } from "@/lib/outreachQueue";
import { telLink, smsLink, whatsappLink, copyToClipboard } from "@/lib/outreachDeepLinks";
import { useIsMobile } from "@/hooks/use-mobile";
import { useBrowserCall } from "@/components/call/BrowserCallProvider";
import { fetchRepCallerNumber } from "@/lib/repCallerNumber";
import { getDefaultSignature } from "@/lib/repProfileQueries";
import { useNavigate } from "react-router-dom";

interface OutreachCardProps {
  touch: OutreachTouch;
  /** Called after the touch is completed/skipped so the parent removes the card. */
  onDone: (touchId: string) => void;
  /** Restore the card if the action failed. */
  onRestore: (touchId: string) => void;
}

// Small collapsible preview of the copy the rep is about to use. Keeps the
// card compact for short strings; adds a "Show more" toggle past ~6 lines.
function PreviewBlock({ label, text }: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const isLong = text.length > 320 || lines.length > 6;
  const shown = expanded || !isLong ? text : lines.slice(0, 6).join("\n");
  return (
    <div className="mt-2 rounded-md border border-border/60 bg-muted/30 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            void copyToClipboard(text).then((ok) => ok && toast.success("Copied"));
          }}
          title="Copy"
        >
          <Copy className="h-3 w-3" /> Copy
        </button>
      </div>
      <p className="whitespace-pre-wrap text-xs text-muted-foreground">{shown}</p>
      {isLong && (
        <button
          type="button"
          className="mt-1 text-[11px] text-primary hover:underline"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function OutreachCard({ touch, onDone, onRestore }: OutreachCardProps) {
  const [opened, setOpened] = useState(false); // rep has tapped the channel action
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [subject, setSubject] = useState(touch.subject || "");
  const [body, setBody] = useState(touch.body || "");
  const [hasSignature, setHasSignature] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void getDefaultSignature()
      .then((sig) => {
        if (cancelled) return;
        const sigText = (sig?.signature_text || "").trim();
        setHasSignature(!!sigText);
        if (!sigText) return;
        setBody((prev) => {
          if (!prev) return prev;
          if (prev.includes(sigText)) return prev;
          return `${prev.trimEnd()}\n\n${sigText}`;
        });
      })
      .catch(() => { if (!cancelled) setHasSignature(false); });
    return () => { cancelled = true; };
  }, []);

  const isMobile = useIsMobile();
  const { makeCall, status: callStatus, leadId: activeCallLeadId, activeCall } = useBrowserCall();
  const [callPrep, setCallPrep] = useState(false);
  const [callConfirmOpen, setCallConfirmOpen] = useState(false);
  const [callerId, setCallerId] = useState<string | null>(null);
  const callInProgress = callStatus === "connecting" || callStatus === "on-call";

  const callPlacedForThisLead = !!activeCall && activeCallLeadId === touch.leadId;
  useEffect(() => {
    if (callPlacedForThisLead) setOpened(true);
  }, [callPlacedForThisLead]);

  const first = touch.leadName.split(" ")[0] || touch.leadName;

  const hasContent = !!(
    touch.subject || touch.body || touch.smsText || touch.talkingPoints || touch.voicemailScript
  );
  const linkedinNeedsUrl = touch.channel === "linkedin" && !touch.linkedinUrl;
  const actionable = hasContent && !linkedinNeedsUrl;

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, successMsg: string) {
    setBusy(true);
    onDone(touch.id);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      onRestore(touch.id);
      toast.error(res.error || "Something went wrong");
      return;
    }
    toast.success(successMsg);
  }

  const handleMarkHandled = () => run(() => markTouchSent(touch.id), "Marked as handled");
  const handleSkip = () => run(() => skipTouch(touch.id), "Skipped this step");
  const handleSnooze = (days: 3 | 5 | 7) =>
    run(() => snoozeTouch(touch.id, days), `Snoozed ${days} days`);

  async function recordOutcome(outcome: "got_them" | "no_answer") {
    await setCallOutcome(touch.id, outcome);
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
      const err = res.error || "Couldn't send";
      if (/postal address/i.test(err) || /CAN-SPAM/i.test(err)) {
        toast.error("Add your company mailing address to send (required by CAN-SPAM).", {
          action: { label: "Open Settings", onClick: () => navigate("/app/settings") },
          duration: 8000,
        });
      } else {
        toast.error(err);
      }
      return;
    }
    toast.success("Sent");
  }

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
    toast.info("Opening your phone to make the call.");
    setOpened(true);
    window.location.href = telLink(phone);
  }

  async function startDesktopCall() {
    setCallConfirmOpen(false);
    const phone = touch.phone;
    if (!callerId || !phone) return;
    try {
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

  function openChannelApp() {
    if (touch.channel === "voice" && touch.phone && !isMobile) {
      void prepareDesktopCall();
      return;
    }
    setOpened(true);
    if (touch.channel === "voice" && touch.phone) {
      window.location.href = telLink(touch.phone);
    } else if (touch.channel === "sms" && touch.phone) {
      window.location.href = smsLink(touch.phone, touch.smsText || touch.body || "");
    } else if (touch.channel === "whatsapp" && (touch.whatsappNumber || touch.phone)) {
      window.open(whatsappLink((touch.whatsappNumber || touch.phone)!, touch.smsText || touch.body || ""), "_blank", "noopener,noreferrer");
    } else if (touch.channel === "linkedin" && touch.linkedinUrl) {
      openLinkedinTouch();
    }
  }

  function openLinkedinTouch() {
    const action = touch.linkedinAction ?? "message";
    const text = touch.body || touch.talkingPoints || "";

    if (action === "react") {
      toast.success("Opening their profile — react on their latest post.");
      window.open(touch.linkedinUrl!, "_blank", "noopener,noreferrer");
      return;
    }
    if (action === "message") {
      const copyPromise = text ? copyToClipboard(text) : Promise.resolve(true);
      void copyPromise.then((ok) => {
        if (ok && text) toast.success("Message copied — paste it in the chat (⌘/Ctrl+V).");
      });
      window.open("https://www.linkedin.com/messaging/compose/", "_blank", "noopener,noreferrer");
      return;
    }
    const copyPromise = text ? copyToClipboard(text) : Promise.resolve(true);
    void copyPromise.then((ok) => {
      if (ok && text) toast.success("Note copied — click Connect → Add a note, then paste (⌘/Ctrl+V).");
    });
    window.open(touch.linkedinUrl!, "_blank", "noopener,noreferrer");
  }

  const linkedinLabel =
    touch.linkedinAction === "connect" ? "Connect" :
    touch.linkedinAction === "react" ? "React" :
    "Message";

  const channelMeta: Record<string, { label: string; icon: ReactNode }> = {
    voice: { label: "Call", icon: <Phone className="h-4 w-4" /> },
    sms: { label: "Text", icon: <MessageSquare className="h-4 w-4" /> },
    whatsapp: { label: "WhatsApp", icon: <MessageSquare className="h-4 w-4" /> },
    linkedin: { label: linkedinLabel, icon: <Linkedin className="h-4 w-4" /> },
  };

  // Build the previews the rep sees BEFORE they act. Content varies by channel.
  const previews: { label: string; text: string }[] = [];
  if (touch.channel === "voice") {
    if (touch.talkingPoints) previews.push({ label: "Talking points", text: touch.talkingPoints });
    if (touch.voicemailScript) previews.push({ label: "Voicemail script", text: touch.voicemailScript });
  } else if (touch.channel === "linkedin") {
    const action = touch.linkedinAction ?? "message";
    if (action === "react") {
      previews.push({
        label: "LinkedIn",
        text: "Open their profile and react on their latest post — no message needed.",
      });
    } else if (touch.body) {
      previews.push({
        label: action === "connect" ? "Connection note" : "Message to paste",
        text: touch.body,
      });
    }
  } else if (touch.channel === "sms" || touch.channel === "whatsapp") {
    const t = touch.smsText || touch.body;
    if (t) previews.push({ label: touch.channel === "sms" ? "Text message" : "WhatsApp message", text: t });
  }

  const primaryAction = (() => {
    if (!actionable) {
      return (
        <Button size="sm" variant="outline" className="h-9 sm:h-8 text-xs" disabled
          title={linkedinNeedsUrl
            ? "No LinkedIn profile on this lead yet — add their LinkedIn URL to use this touch."
            : "No content for this lead's industry yet — add a General variant or this industry's copy in the campaign."}>
          {linkedinNeedsUrl ? "No profile" : "No content"}
        </Button>
      );
    }
    if (touch.channel === "email") {
      return (
        <Button size="sm" className="h-9 sm:h-8 text-xs gap-1.5" disabled={busy} onClick={() => setReviewOpen(true)}>
          <Send className="h-4 w-4" /> <span className="hidden sm:inline">Send</span>
        </Button>
      );
    }
    const voiceBusy = touch.channel === "voice" && (callPrep || callInProgress);
    const label = voiceBusy ? (callInProgress ? "In call" : "Connecting…") : channelMeta[touch.channel]?.label;
    return (
      <Button
        size="sm"
        className="h-9 sm:h-8 text-xs gap-1.5"
        disabled={busy || voiceBusy}
        onClick={openChannelApp}
        title={label}
      >
        {voiceBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : channelMeta[touch.channel]?.icon}
        <span className="hidden sm:inline">{label}</span>
      </Button>
    );
  })();

  return (
    <div className="rounded-lg border border-border bg-card p-3 transition-colors hover:bg-card/80">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{touch.leadName}</span>
            <Badge variant="secondary" className="shrink-0 text-[10px]">{touch.campaignName}</Badge>
          </div>
          <div className="truncate text-xs text-muted-foreground">{touch.company || "—"}</div>
        </div>

        <div className="flex shrink-0 items-center gap-1 ml-auto">
          {primaryAction}

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 sm:h-8 sm:w-8"
            disabled={busy}
            onClick={handleMarkHandled}
            title="Mark as handled"
            aria-label="Mark as handled"
          >
            <Check className="h-4 w-4" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 sm:h-8 sm:w-8"
                disabled={busy}
                onClick={(e) => e.stopPropagation()}
                title="Snooze"
                aria-label="Snooze"
              >
                <Clock className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleSnooze(3)}>Snooze 3 days</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleSnooze(5)}>Snooze 5 days</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleSnooze(7)}>Snooze 7 days</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleSkip}
                className="text-destructive focus:text-destructive"
              >
                Skip this step
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="basis-full min-w-0">
          {/* Preview block(s) — visible immediately so the rep sees the copy. */}
          {actionable && previews.map((p) => (
            <PreviewBlock key={p.label} label={p.label} text={p.text} />
          ))}

          {/* Post-call outcome buttons appear only after a real call is placed. */}
          {touch.channel === "voice" && opened && (
            <div className="mt-2 flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => recordOutcome("got_them")}>Got them</Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => recordOutcome("no_answer")}>No answer</Button>
            </div>
          )}
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
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} placeholder="Email body" />
            {hasSignature === false && (
              <p className="text-[11px] text-muted-foreground">
                No signature set ·{" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => { setReviewOpen(false); navigate("/app/settings"); }}
                >
                  Add one in Settings
                </button>
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              A CAN-SPAM footer with your company address and an unsubscribe link is added automatically.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReviewOpen(false)}>Cancel</Button>
            <Button disabled={busy || !subject.trim() || !body.trim()} onClick={handleReviewSend}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
