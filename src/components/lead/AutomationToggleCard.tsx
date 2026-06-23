// AutomationToggleCard — the slim, rep-facing automation control for the lead
// right rail (Unit 3). A single on/off Switch + a one-line plain-English status,
// with the full control surface (scheduled steps, preview, Stop/Resume) tucked
// into a collapsed "Details" disclosure — hidden, not deleted.
//
// Automation LOGIC is unchanged: enable/disable write the exact same fields as
// AutomationPreviewCard (shared via @/lib/leadAutomationActions), and the
// executor's pause-on-reply / pause-on-meeting safety still governs sends. This
// component only changes how that control is presented. Turning ON refuses to
// RESUME a previously-enrolled lead while a safety blocker persists (mirrors the
// legacy Resume guard), but a first-time enable is unguarded (mirrors the legacy
// Enable path) so an inbound/lookback-seeded lead carrying last_inbound_at can
// still be enrolled.

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Zap, ChevronDown, Loader2, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { LeadDetail } from "@/lib/supabaseQueries";
import {
  getAutomationToggleState, getAutomationResumeBlocker, buildAutomationEnableFields, AUTOMATION_DISABLE_FIELDS,
} from "@/lib/leadAutomationActions";
import AutomationPreviewCard from "@/components/lead/AutomationPreviewCard";

interface Props {
  lead: LeadDetail;
  onUpdate: () => void;
}

export default function AutomationToggleCard({ lead, onUpdate }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

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
    description = `Paused — ${(primaryBlocker ?? "on hold").toLowerCase()}. Open Details to manage.`;
  } else if (isOn) {
    description = "On — sending the follow-ups for you. Pauses automatically if they reply or book a meeting.";
  } else if (userPaused) {
    description = "Paused — turn on to resume the sequence.";
  } else {
    description = "Off — turn on and we'll send the follow-ups for you. Pauses if they reply or you book a meeting.";
  }

  const handleToggle = async (next: boolean) => {
    if (next) {
      // Respect pause-on-reply / pause-on-meeting on RESUME only — never re-arm a
      // previously-enrolled lead while a safety blocker persists. A first-time
      // enable (never enrolled, e.g. an inbound lead that carries last_inbound_at)
      // is allowed, matching the legacy Enable path.
      const resumeBlocker = getAutomationResumeBlocker(lead);
      if (resumeBlocker) {
        toast.error(`Can't resume — ${resumeBlocker.toLowerCase()}. Open Details to stop the sequence.`);
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
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isUnsubscribed ? (
            <Ban className="h-3.5 w-3.5 shrink-0 text-destructive" />
          ) : (
            <Zap className={cn("h-3.5 w-3.5 shrink-0", isOn ? "text-primary" : "text-muted-foreground")} />
          )}
          <span className="text-sm font-medium text-foreground">Automation</span>
        </div>
        <Switch
          checked={isOn}
          disabled={busy || isUnsubscribed}
          onCheckedChange={handleToggle}
          aria-label="Turn automation on or off"
        />
      </div>

      <p className="text-xs text-muted-foreground">{description}</p>

      {/* Details — full control surface, collapsed by default (hide, don't delete). */}
      {!isUnsubscribed && (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground py-1">
            <ChevronDown className={cn("h-3 w-3 transition-transform", detailsOpen && "rotate-180")} />
            Details
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1">
            <AutomationPreviewCard lead={lead} onUpdate={onUpdate} />
          </CollapsibleContent>
        </Collapsible>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!busy) setConfirmOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on automation for this lead?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  We'll start sending <strong>{motion === "nurture" ? "nurture emails" : "follow-up emails"}</strong> to{" "}
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

      <Separator className="bg-border/40" />
    </div>
  );
}
