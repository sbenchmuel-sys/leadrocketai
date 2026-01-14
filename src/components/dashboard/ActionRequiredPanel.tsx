import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, Mail, FileText, Eye, Send, X } from "lucide-react";
import { EnrichedLead, getActionType } from "@/lib/dashboardUtils";
import { EmailActionDialog } from "./EmailActionDialog";
import { dismissLeadAction } from "@/lib/supabaseQueries";
import { toast } from "sonner";

interface ActionRequiredPanelProps {
  leads: EnrichedLead[];
  onLeadUpdated?: () => void;
}

export function ActionRequiredPanel({ leads, onLeadUpdated }: ActionRequiredPanelProps) {
  const [selectedLead, setSelectedLead] = useState<EnrichedLead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  
  const actionLeads = leads.filter((l) => l.needs_action).slice(0, 5);

  const handleDismiss = async (lead: EnrichedLead, e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissingId(lead.id);
    try {
      await dismissLeadAction(lead.id);
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

  if (actionLeads.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <AlertCircle className="h-5 w-5 text-muted-foreground" />
            Action Required
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            All caught up! No leads need immediate action.
          </p>
        </CardContent>
      </Card>
    );
  }

  const getActionButton = (lead: EnrichedLead) => {
    const actionType = getActionType(lead.next_action_key);

    switch (actionType) {
      case "reply":
        return (
          <Button size="sm" onClick={() => handleOpenEmailDialog(lead)}>
            <Mail className="h-4 w-4 mr-1" />
            Reply
          </Button>
        );
      case "follow_up":
        return (
          <Button size="sm" onClick={() => handleOpenEmailDialog(lead)}>
            <FileText className="h-4 w-4 mr-1" />
            Draft
          </Button>
        );
      case "recap":
        return (
          <Button size="sm" onClick={() => handleOpenEmailDialog(lead)}>
            <FileText className="h-4 w-4 mr-1" />
            Recap
          </Button>
        );
      case "nurture":
        return (
          <Button size="sm" onClick={() => handleOpenEmailDialog(lead)}>
            <Send className="h-4 w-4 mr-1" />
            Send
          </Button>
        );
      default:
        return (
          <Button size="sm" variant="outline" asChild>
            <Link to={`/dashboard/leads/${lead.id}`}>
              <Eye className="h-4 w-4 mr-1" />
              View
            </Link>
          </Button>
        );
    }
  };

  return (
    <>
      <Card className="border-orange-200 dark:border-orange-900/50 bg-orange-50/50 dark:bg-orange-950/20">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <AlertCircle className="h-5 w-5 text-orange-600 dark:text-orange-400" />
            Action Required
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {actionLeads.map((lead) => (
            <div
              key={lead.id}
              className="flex items-center justify-between p-3 bg-background rounded-lg border"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground truncate">
                  {lead.name}
                  <span className="text-muted-foreground font-normal"> · {lead.company}</span>
                </p>
                <p className="text-sm text-muted-foreground truncate">
                  {lead.next_action_label || "Action needed"}
                </p>
              </div>
              <div className="ml-3 flex-shrink-0 flex items-center gap-1">
                {getActionButton(lead)}
                <Button 
                  size="sm" 
                  variant="ghost" 
                  asChild
                  className="text-muted-foreground"
                >
                  <Link to={`/dashboard/leads/${lead.id}`}>
                    <Eye className="h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={(e) => handleDismiss(lead, e)}
                  disabled={dismissingId === lead.id}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {selectedLead && (
        <EmailActionDialog
          lead={selectedLead}
          open={dialogOpen}
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
