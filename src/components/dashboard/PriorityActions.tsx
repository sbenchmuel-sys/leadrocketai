import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Mail, FileText, Eye, Send, X, RefreshCw, Wand2, Loader2, Check } from "lucide-react";
import { EnrichedLead, getActionType, STAGE_LABELS, DealStage, RevenueState } from "@/lib/dashboardUtils";
import { NurtureSwitchDialog } from "./NurtureSwitchDialog";
import { EmailActionDialog } from "./EmailActionDialog";
import { dismissLeadAction, setLeadPermanentDismiss } from "@/lib/supabaseQueries";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useBackgroundDraftQueue } from "@/hooks/useBackgroundDraftQueue";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";


const SNOOZE_OPTIONS = [
  { days: 1, label: "Snooze 1 day" },
  { days: 3, label: "Snooze 3 days" },
  { days: 7, label: "Snooze 7 days" },
];

const URGENCY_PRIORITY: Record<string, number> = {
  reply_now: 1,
  generate_post_meeting_recap: 2,
  send_proposal: 3,
  closing_followup: 3,
  send_pre_2: 4,
  send_pre_3: 5,
};

interface PriorityActionsProps {
  leads: EnrichedLead[];
  allLeads?: EnrichedLead[];
  revenueStateFilter: RevenueState;
  onLeadUpdated?: () => void;
}

export function PriorityActions({ leads, allLeads, revenueStateFilter, onLeadUpdated }: PriorityActionsProps) {
  const navigate = useNavigate();
  const [nurtureSwitchLead, setNurtureSwitchLead] = useState<EnrichedLead | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [selectedLead, setSelectedLead] = useState<EnrichedLead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { enqueue, getStatus, consume } = useBackgroundDraftQueue();

  const handlePreGenerate = (lead: EnrichedLead, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const status = getStatus(lead.id);
    if (status?.status === "generating") return;
    if (status?.status === "ready") {
      const entry = consume(lead.id);
      if (entry?.result) {
        setSelectedLead({
          ...lead,
          _prefilledBody: entry.result.draft_text,
          _prefilledSubject: entry.result.suggested_subject || entry.subject,
        } as any);
        setDialogOpen(true);
      }
      return;
    }
    enqueue(lead.id);
  };

  const actionLeads = useMemo(() => {
    const isActionable = (l: EnrichedLead) =>
      l.revenueState === "action_required";

    const sortByUrgency = (list: EnrichedLead[]) =>
      [...list].sort((a, b) => {
        const ap = URGENCY_PRIORITY[a.next_action_key || "reply_now"] || 10;
        const bp = URGENCY_PRIORITY[b.next_action_key || "reply_now"] || 10;
        return ap - bp;
      });

    if (revenueStateFilter === "action_required") {
      return sortByUrgency(leads.filter(isActionable)).slice(0, 5);
    }

    if (revenueStateFilter === "active") {
      const actionPool = (allLeads ?? leads).filter(
        (l) => l.revenueState === "action_required"
      );
      return sortByUrgency(actionPool).slice(0, 3);
    }

    return sortByUrgency(leads.filter(isActionable)).slice(0, 3);
  }, [leads, allLeads, revenueStateFilter]);

  const handleDismiss = async (lead: EnrichedLead, snoozeDays: number) => {
    setDismissingId(lead.id);
    try {
      await dismissLeadAction(lead.id, snoozeDays);
      toast.success(`Snoozed ${lead.name} for ${snoozeDays} day${snoozeDays > 1 ? "s" : ""}`);
      onLeadUpdated?.();
    } catch (err) {
      console.error("Failed to snooze action:", err);
      toast.error("Failed to snooze action");
    } finally {
      setDismissingId(null);
    }
  };

  // PR 2.4 — permanent dismiss with 5-second undo toast.
  const handlePermanentDismiss = async (lead: EnrichedLead) => {
    setDismissingId(lead.id);
    try {
      const snapshot = await setLeadPermanentDismiss(lead.id, true);
      toast.success(`Dismissed ${lead.name}`, {
        duration: 5000,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await setLeadPermanentDismiss(lead.id, false, snapshot ?? undefined);
              toast.success("Undone");
              onLeadUpdated?.();
            } catch (err) {
              console.error("Undo dismiss failed:", err);
              toast.error("Undo failed");
            }
          },
        },
      });
      onLeadUpdated?.();
    } catch (err) {
      console.error("Failed to dismiss action:", err);
      toast.error("Failed to dismiss action");
    } finally {
      setDismissingId(null);
    }
  };

  const handleNavigateToLead = (lead: EnrichedLead) => {
    navigate(`/app/leads/${lead.id}`, { state: { originContext: "dashboard" } });
  };

  const getActionButton = (lead: EnrichedLead) => {
    // If no explicit action key but lead is action_required (unreplied inbound), default to reply
    const effectiveActionKey = lead.next_action_key ||
      (lead.revenueState === "action_required" && lead.last_inbound_at ? "reply_now" : null);
    const actionType = getActionType(effectiveActionKey);
    const actionReasonCode = (lead as any).action_reason_code;

    if (actionReasonCode === "NURTURE_SWITCH_RECOMMENDED") {
      return (
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => setNurtureSwitchLead(lead)}
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          Nurture
        </Button>
      );
    }

    const config: Record<string, { icon: typeof Mail; label: string }> = {
      reply: { icon: Mail, label: "Reply Now" },
      follow_up: { icon: FileText, label: "Review Draft" },
      recap: { icon: FileText, label: "Send Follow-Up" },
      nurture: { icon: Send, label: "Approve" },
    };

    const entry = config[actionType];
    if (entry) {
      const Icon = entry.icon;
      return (
        <Button size="sm" className="h-8 text-xs" onClick={() => handleNavigateToLead(lead)}>
          <Icon className="h-3 w-3 mr-1" />
          {entry.label}
        </Button>
      );
    }

    return (
      <Button size="sm" variant="outline" className="h-8 text-xs" asChild>
        <Link to={`/app/leads/${lead.id}`} state={{ originContext: "dashboard" }}>
          <Eye className="h-3 w-3 mr-1" />
          View
        </Link>
      </Button>
    );
  };

  return (
    <>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Action Required</h3>

        {actionLeads.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No conversations in this state.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {actionLeads.map((lead) => {
              const stage = STAGE_LABELS[lead.stage as DealStage] ?? lead.stage;
              return (
                <div
                  key={lead.id}
                  className="flex items-center gap-3 rounded-md border border-border bg-card/50 px-4 py-3"
                >
                  <Link
                    to={`/app/leads/${lead.id}`}
                    className="min-w-0 flex-1 hover:underline"
                  >
                    <span className="text-sm font-medium text-foreground block truncate">
                      {lead.name}
                    </span>
                    <span className="text-xs text-muted-foreground block truncate">
                      {stage} · {lead.next_action_label || "Action needed"}
                    </span>
                  </Link>

                  {/* Pre-generate draft button */}
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {(() => {
                          const draftStatus = getStatus(lead.id);
                          return (
                            <Button
                              size="icon"
                              variant="ghost"
                              className={cn(
                                "h-7 w-7 shrink-0",
                                draftStatus?.status === "ready" && "text-success"
                              )}
                              onClick={(e) => handlePreGenerate(lead, e)}
                              disabled={draftStatus?.status === "generating"}
                            >
                              {draftStatus?.status === "generating" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : draftStatus?.status === "ready" ? (
                                <Check className="h-3.5 w-3.5" />
                              ) : (
                                <Wand2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          );
                        })()}
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        {(() => {
                          const ds = getStatus(lead.id);
                          return ds?.status === "generating" ? "Generating draft…" : ds?.status === "ready" ? "Draft ready — click to open" : "Pre-generate draft";
                        })()}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>

                  <div className="shrink-0">{getActionButton(lead)}</div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                        disabled={dismissingId === lead.id}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                        Snooze for...
                      </p>
                      {SNOOZE_OPTIONS.map((option) => (
                        <DropdownMenuItem
                          key={option.days}
                          onClick={() => handleDismiss(lead, option.days)}
                        >
                          {option.label}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => handlePermanentDismiss(lead)}
                      >
                        Dismiss
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {nurtureSwitchLead && (
        <NurtureSwitchDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setNurtureSwitchLead(null);
              onLeadUpdated?.();
            }
          }}
          leadId={nurtureSwitchLead.id}
          leadName={nurtureSwitchLead.name}
          onSuccess={onLeadUpdated}
        />
      )}

      {selectedLead && (
        <EmailActionDialog
          lead={selectedLead}
          open={dialogOpen}
          prefilledSubject={(selectedLead as any)._prefilledSubject || undefined}
          prefilledBody={(selectedLead as any)._prefilledBody || undefined}
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