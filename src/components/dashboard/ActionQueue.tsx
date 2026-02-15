import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Mail, FileText, Send, Phone, Eye, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { EnrichedLead, STAGE_LABELS, DealStage } from "@/lib/dashboardUtils";
import { EmailActionDialog } from "./EmailActionDialog";
import { NurtureSwitchDialog } from "./NurtureSwitchDialog";
import { dismissLeadAction } from "@/lib/supabaseQueries";
import { toast } from "sonner";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ─── Priority tiers ───────────────────────────────────────────
export type ActionType = "Reply" | "Follow-up" | "Send Proposal" | "Call" | "Review";

export interface QueueItem {
  lead: EnrichedLead;
  priority: number;
  reason: string;
  timeSince: string;
  actionType: ActionType;
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

function formatDuration(hours: number): string {
  if (hours < 1) return "< 1 hour";
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function classifyLead(lead: EnrichedLead): QueueItem | null {
  const now = Date.now();

  // Skip closed leads
  if (lead.stage === "closed_won" || lead.stage === "closed_lost") return null;

  // P1: Inbound unanswered > 12h
  if (lead.last_inbound_at) {
    const hSinceInbound = hoursSince(lead.last_inbound_at);
    const hasReplied = lead.last_outbound_at && new Date(lead.last_outbound_at) > new Date(lead.last_inbound_at);
    if (!hasReplied && hSinceInbound > 12) {
      return {
        lead,
        priority: 1,
        reason: `Unanswered message for ${formatDuration(hSinceInbound)}.`,
        timeSince: formatDuration(hSinceInbound),
        actionType: "Reply",
      };
    }
  }

  // P2: Post-meeting with no follow-up > 24h
  if (lead.hasMeeting && (lead.stage === "post_meeting" || lead.motion === "post_meeting")) {
    // No outbound after last activity (meeting)
    const lastActivity = lead.last_activity_at ? hoursSince(lead.last_activity_at) : 0;
    const hasFollowUp = lead.last_outbound_at && lead.last_activity_at &&
      new Date(lead.last_outbound_at) >= new Date(lead.last_activity_at);
    if (!hasFollowUp && lastActivity > 24) {
      return {
        lead,
        priority: 2,
        reason: `Meeting completed ${formatDuration(lastActivity)} ago. No recap sent.`,
        timeSince: formatDuration(lastActivity),
        actionType: "Follow-up",
      };
    }
  }

  // P3: Proposal sent / closing stage, no response > 3 days (72h)
  if (lead.stage === "closing" || lead.motion === "closing") {
    if (lead.last_outbound_at && !lead.last_inbound_at) {
      const hSinceOutbound = hoursSince(lead.last_outbound_at);
      if (hSinceOutbound > 72) {
        return {
          lead,
          priority: 3,
          reason: `Proposal sent ${formatDuration(hSinceOutbound)} ago. No response.`,
          timeSince: formatDuration(hSinceOutbound),
          actionType: "Send Proposal",
        };
      }
    }
    if (lead.last_outbound_at && lead.last_inbound_at) {
      const hSinceLastInbound = hoursSince(lead.last_inbound_at);
      const outboundAfterInbound = new Date(lead.last_outbound_at) > new Date(lead.last_inbound_at);
      if (outboundAfterInbound && hSinceLastInbound > 72) {
        return {
          lead,
          priority: 3,
          reason: `Closing stage. No reply in ${formatDuration(hSinceLastInbound)}.`,
          timeSince: formatDuration(hSinceLastInbound),
          actionType: "Call",
        };
      }
    }
  }

  // P4: Waiting on customer > 5 days (120h)
  if (lead.last_outbound_at) {
    const outboundIsLatest = !lead.last_inbound_at || new Date(lead.last_outbound_at) > new Date(lead.last_inbound_at);
    if (outboundIsLatest) {
      const hSinceOutbound = hoursSince(lead.last_outbound_at);
      if (hSinceOutbound > 120) {
        return {
          lead,
          priority: 4,
          reason: `Waiting on customer for ${formatDuration(hSinceOutbound)}.`,
          timeSince: formatDuration(hSinceOutbound),
          actionType: "Follow-up",
        };
      }
    }
  }

  // P5: All others with needs_action, sorted by oldest activity
  if (lead.needs_action) {
    const activityAge = lead.last_activity_at ? hoursSince(lead.last_activity_at) : 0;
    return {
      lead,
      priority: 5,
      reason: lead.next_action_label || `Last activity ${formatDuration(activityAge)} ago.`,
      timeSince: formatDuration(activityAge),
      actionType: "Review",
    };
  }

  return null;
}

// ─── Action type badge colors (using existing semantic tokens) ───
const ACTION_BADGE_STYLES: Record<ActionType, string> = {
  Reply: "bg-destructive/10 text-destructive",
  "Follow-up": "bg-warning/10 text-warning",
  "Send Proposal": "bg-primary/10 text-primary",
  Call: "bg-orange-500/10 text-orange-500",
  Review: "bg-muted text-muted-foreground",
};

const ACTION_ICONS: Record<ActionType, typeof Mail> = {
  Reply: Mail,
  "Follow-up": FileText,
  "Send Proposal": Send,
  Call: Phone,
  Review: Eye,
};

const DISMISS_REASONS = [
  { code: "already_handled", label: "Already handled" },
  { code: "not_relevant", label: "Not relevant" },
  { code: "will_do_later", label: "Will do later" },
  { code: "other", label: "Other" },
];

// ─── Component ────────────────────────────────────────────────
interface ActionQueueProps {
  leads: EnrichedLead[];
  onLeadUpdated?: () => void;
}

export function ActionQueue({ leads, onLeadUpdated }: ActionQueueProps) {
  const [selectedLead, setSelectedLead] = useState<EnrichedLead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  const queue = useMemo(() => {
    const items: QueueItem[] = [];
    for (const lead of leads) {
      const item = classifyLead(lead);
      if (item) items.push(item);
    }
    // Sort by priority tier, then by oldest activity within tier
    return items.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aTime = new Date(a.lead.last_activity_at).getTime();
      const bTime = new Date(b.lead.last_activity_at).getTime();
      return aTime - bTime; // oldest first
    });
  }, [leads]);

  const handleDismiss = async (lead: EnrichedLead, reasonCode: string) => {
    setDismissingId(lead.id);
    try {
      await dismissLeadAction(lead.id, reasonCode);
      toast.success(`Dismissed action for ${lead.name}`);
      onLeadUpdated?.();
    } catch {
      toast.error("Failed to dismiss action");
    } finally {
      setDismissingId(null);
    }
  };

  const handleAction = (lead: EnrichedLead) => {
    setSelectedLead(lead);
    setDialogOpen(true);
  };

  return (
    <>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Action Queue</h3>

        {queue.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No actions pending. Assistant is progressing deals autonomously.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {queue.map((item) => {
              const stage = STAGE_LABELS[item.lead.stage as DealStage] ?? item.lead.stage;
              const Icon = ACTION_ICONS[item.actionType];

              return (
                <div
                  key={item.lead.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card/50 px-4 py-3"
                >
                  {/* Lead info */}
                  <Link
                    to={`/app/leads/${item.lead.id}`}
                    className="min-w-0 flex-1 hover:underline"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {item.lead.name}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">{stage}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {item.reason}
                    </p>
                  </Link>

                  {/* Action type badge */}
                  <span
                    className={cn(
                      "shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                      ACTION_BADGE_STYLES[item.actionType]
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    {item.actionType}
                  </span>

                  {/* Primary action */}
                  <Button
                    size="sm"
                    className="h-8 text-xs shrink-0"
                    onClick={() => handleAction(item.lead)}
                  >
                    {item.actionType === "Reply" ? "Reply Now" :
                     item.actionType === "Call" ? "Call" :
                     item.actionType === "Send Proposal" ? "Send" :
                     item.actionType === "Follow-up" ? "Follow Up" :
                     "Review"}
                  </Button>

                  {/* Dismiss */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                        disabled={dismissingId === item.lead.id}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                        Dismiss because...
                      </p>
                      {DISMISS_REASONS.map((reason) => (
                        <DropdownMenuItem
                          key={reason.code}
                          onClick={() => handleDismiss(item.lead, reason.code)}
                        >
                          {reason.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedLead && (
        <EmailActionDialog
          lead={selectedLead}
          open={dialogOpen}
          initialInstructions=""
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) {
              setSelectedLead(null);
              onLeadUpdated?.();
            }
          }}
        />
      )}
    </>
  );
}
