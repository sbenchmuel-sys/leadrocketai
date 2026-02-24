import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertCircle, Mail, FileText, Eye, Send, X, RefreshCw, Plane } from "lucide-react";
import { EnrichedLead, getActionType, STAGE_LABELS, DealStage } from "@/lib/dashboardUtils";
import { EmailActionDialog } from "./EmailActionDialog";
import { NurtureSwitchDialog } from "./NurtureSwitchDialog";
import { dismissLeadAction } from "@/lib/supabaseQueries";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const DISMISS_REASONS = [
  { code: "already_handled", label: "Already handled" },
  { code: "not_relevant", label: "Not relevant" },
  { code: "will_do_later", label: "Will do later" },
  { code: "other", label: "Other" },
];

interface ActionRequiredPanelProps {
  leads: EnrichedLead[];
  onLeadUpdated?: () => void;
}

export function ActionRequiredPanel({ leads, onLeadUpdated }: ActionRequiredPanelProps) {
  const [selectedLead, setSelectedLead] = useState<EnrichedLead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [nurtureSwitchLead, setNurtureSwitchLead] = useState<EnrichedLead | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [currentInstructions] = useState("");

  const actionLeads = leads.filter((l) => l.needs_action && l.revenueState !== "automation").slice(0, 3);

  const handleDismiss = async (lead: EnrichedLead, reasonCode: string) => {
    setDismissingId(lead.id);
    try {
      await dismissLeadAction(lead.id, reasonCode);
      toast.success(`Dismissed action for ${lead.name}`);
      onLeadUpdated?.();
    } catch (err) {
      console.error("Failed to dismiss action:", err);
      toast.error("Failed to dismiss action");
    } finally {
      setDismissingId(null);
    }
  };

  const handleOpenEmailDialog = (lead: EnrichedLead) => {
    setSelectedLead(lead);
    setDialogOpen(true);
  };

  const getActionButton = (lead: EnrichedLead) => {
    const actionType = getActionType(lead.next_action_key);
    const actionReasonCode = (lead as any).action_reason_code;

    if (actionReasonCode === "NURTURE_SWITCH_RECOMMENDED") {
      return (
        <Button
          size="sm"
          variant="outline"
          className="border-primary text-primary hover:bg-primary hover:text-primary-foreground h-7 text-xs"
          onClick={() => setNurtureSwitchLead(lead)}
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          Nurture
        </Button>
      );
    }

    if (actionType === "view" && (lead as any).next_action_key === "ooo_return_followup") {
      return (
        <Button size="sm" variant="outline" className="h-7 text-xs border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30" asChild>
          <Link to={`/app/leads/${lead.id}`} state={{ originContext: "dashboard" }}>
            <Plane className="h-3 w-3 mr-1" />
            Follow up
          </Link>
        </Button>
      );
    }

    const config: Record<string, { icon: typeof Mail; label: string }> = {
      reply: { icon: Mail, label: "Reply" },
      follow_up: { icon: FileText, label: "Draft" },
      recap: { icon: FileText, label: "Recap" },
      nurture: { icon: Send, label: "Send" },
    };

    const entry = config[actionType];
    if (entry) {
      const Icon = entry.icon;
      return (
        <Button size="sm" className="h-7 text-xs" onClick={() => handleOpenEmailDialog(lead)}>
          <Icon className="h-3 w-3 mr-1" />
          {entry.label}
        </Button>
      );
    }

    return (
      <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
        <Link to={`/app/leads/${lead.id}`} state={{ originContext: "dashboard" }}>
          <Eye className="h-3 w-3 mr-1" />
          View
        </Link>
      </Button>
    );
  };

  if (actionLeads.length === 0) {
    return (
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <AlertCircle className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Action Required</h3>
        </div>
        <p className="text-sm text-muted-foreground text-center py-2">
          All caught up!
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border border-warning/30 bg-gradient-to-br from-warning/5 to-transparent p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-warning" />
            <h3 className="text-sm font-semibold text-foreground">Action Required</h3>
          </div>
          <span className="text-xs text-muted-foreground">{actionLeads.length} pending</span>
        </div>

        <div className="space-y-1.5">
          {actionLeads.map((lead) => {
            const phase = STAGE_LABELS[lead.stage as DealStage] ?? lead.stage;

            return (
              <div
                key={lead.id}
                className="flex items-center gap-3 rounded-md bg-background px-3 py-2 border border-border/50"
              >
                {/* Info */}
                <Link
                  to={`/app/leads/${lead.id}`}
                  state={{ originContext: "dashboard" }}
                  className="min-w-0 flex-1 hover:underline"
                >
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="font-medium text-foreground truncate">{lead.name}</span>
                    <span className="text-muted-foreground truncate hidden sm:inline">· {lead.company}</span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {lead.next_action_label || "Action needed"}
                  </p>
                </Link>

                {/* Phase badge */}
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 shrink-0 hidden md:inline-flex">
                  {phase}
                </Badge>

                {/* Primary action */}
                <div className="shrink-0">{getActionButton(lead)}</div>

                {/* Dismiss */}
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
                      Dismiss because...
                    </p>
                    {DISMISS_REASONS.map((reason) => (
                      <DropdownMenuItem
                        key={reason.code}
                        onClick={() => handleDismiss(lead, reason.code)}
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
      </div>

      {selectedLead && (
        <EmailActionDialog
          lead={selectedLead}
          open={dialogOpen}
          initialInstructions={currentInstructions}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) {
              setSelectedLead(null);
              onLeadUpdated?.();
            }
          }}
        />
      )}

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
    </>
  );
}
