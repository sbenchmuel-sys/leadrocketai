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

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Phone, MessageSquare, Send, Loader2, Linkedin } from "lucide-react";
import { toast } from "sonner";
import type { OutreachTouch } from "@/lib/outreachQueue";
import { sendReviewEmail, markTouchSent, skipTouch, setCallOutcome } from "@/lib/outreachQueue";
import { telLink, smsLink, whatsappLink, copyToClipboard } from "@/lib/outreachDeepLinks";

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

  // ── Primary action per channel ──
  function openChannelApp() {
    setOpened(true);
    if (touch.channel === "voice" && touch.phone) {
      window.location.href = telLink(touch.phone);
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
            <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={openChannelApp}>
              {channelMeta[touch.channel]?.icon}
              {channelMeta[touch.channel]?.label}
            </Button>
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
    </div>
  );
}
