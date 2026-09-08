// AutomationToggleCard — the rep-facing automation control for the lead page
// (Unit L2). Renders as a CHIP that is itself the switch, so it sits in the
// header chip row on every screen size (it used to live in a desktop-only
// right rail, invisible on a phone).
//
// Automation LOGIC is unchanged: enable/disable write the exact same fields as
// AutomationPreviewCard (shared via @/lib/leadAutomationActions), and the
// executor's pause-on-reply / pause-on-meeting safety still governs sends. This
// component only changes how that control is presented. Turning ON refuses to
// RESUME a previously-enrolled lead while a safety blocker persists (mirrors the
// legacy Resume guard), but a first-time enable is unguarded (mirrors the legacy
// Enable path) so an inbound/lookback-seeded lead carrying last_inbound_at can
// still be enrolled. The full control surface (scheduled steps, preview,
// Stop/Resume/Disable) now lives in the "More about this deal" sheet →
// "Automation details".

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Zap, Loader2, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { LeadDetail } from "@/lib/supabaseQueries";
import {
  getAutomationToggleState, getAutomationResumeBlocker, buildAutomationEnableFields, AUTOMATION_DISABLE_FIELDS,
} from "@/lib/leadAutomationActions";

interface Props {
  lead: LeadDetail;
  onUpdate: () => void;
}

export default function AutomationToggleCard({ lead, onUpdate }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const motion = lead.motion;
  const { eligible, isUnsubscribed, safetyPaused, userPaused, isOn, primaryBlocker } =
    getAutomationToggleState(lead);
  if (!eligible) return null;

  let description: string;
  if (isUnsubscribed) {
    description = "This lead unsubscribed — automation stays off.";
  } else if (safetyPaused) {
    // Checked BEFORE isOn: during the reply/meeting window the lead can still
    // look enabled, but it's effectively paused — surface that, don't hide it.
    description = `Paused — ${(primaryBlocker ?? "on hold").toLowerCase()}. Open "More about this deal" to manage.`;
  } else if (isOn) {
    description = "On — sending the follow-ups for you. Pauses automatically if they reply or book a meeting.";
  } else if (userPaused) {
    description = "Paused — turn on to resume the sequence.";
  } else {
    description = "Off — turn on and we'll send the follow-ups for you. Pauses if they reply or you book a meeting.";
  }

  const chipLabel = isUnsubscribed
    ? "Automation off"
    : safetyPaused
      ? "Automation paused"
      : isOn
        ? "Automation on"
        : "Automation off";

  const handleToggle = async (next: boolean) => {
    if (next) {
      // Respect pause-on-reply / pause-on-meeting on RESUME only — never re-arm a
      // previously-enrolled lead while a safety blocker persists. A first-time
      // enable (never enrolled, e.g. an inbound lead that carries last_inbound_at)
      // is allowed, matching the legacy Enable path.
      const resumeBlocker = getAutomationResumeBlocker(lead);
      if (resumeBlocker) {
        toast.error(`Can't resume — ${resumeBlocker.toLowerCase()}. Open "More about this deal" to stop the sequence.`);
        return;
      }
      setConfirmOpen(true);
      return;
    }
    // Turning off is always safe — disable immediately, no confirm.
    setBusy(true);
    try {
      await supabase.from("leads").update(AUTOMATION_DISABLE_FIELDS).eq("id", lead.id);
      toast.success("Automation turned off");
      onUpdate();
    } catch (err) {
      console.error("Failed to turn off automation:", err);
      toast.error("Failed to turn off automation");
    } finally {
      setBusy(false);
    }
  };

  const confirmEnable = async () => {
    setBusy(true);
    try {
      await supabase.from("leads").update(buildAutomationEnableFields(lead)).eq("id", lead.id);
      toast.success("Automation on. Next step scheduled.");
      onUpdate();
    } catch (err) {
      console.error("Failed to turn on automation:", err);
      toast.error("Failed to turn on automation");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  return (
    <>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
          isOn && !safetyPaused
            ? "border-primary/30 bg-primary/10 text-primary"
            : "border-border bg-muted/50 text-muted-foreground",
        )}
        title={description}
      >
        {isUnsubscribed ? <Ban className="h-3 w-3 shrink-0" /> : <Zap className="h-3 w-3 shrink-0" />}
        {chipLabel}
        <Switch
          checked={isOn}
          disabled={busy || isUnsubscribed}
          onCheckedChange={handleToggle}
          aria-label="Turn automation on or off"
          className="ml-0.5 scale-90"
        />
      </span>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!busy) setConfirmOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on automation for this lead?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  We'll start sending <strong>{motion === "nurture" ? "slow-drip emails" : "follow-up emails"}</strong> to{" "}
                  <strong>{lead.name || lead.email || "this lead"}</strong> for you.
                </p>
                <p className="text-muted-foreground">
                  Automation pauses automatically on a reply, a booked meeting, or opt-out. You can turn it off any time.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); confirmEnable(); }} disabled={busy}>
              {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Zap className="h-3 w-3 mr-1" />}
              Turn on
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
