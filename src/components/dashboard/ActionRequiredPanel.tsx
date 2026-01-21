import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, Mail, FileText, Eye, Send, X, Lightbulb, ChevronDown, ChevronRight } from "lucide-react";
import { EnrichedLead, getActionType } from "@/lib/dashboardUtils";
import { EmailActionDialog } from "./EmailActionDialog";
import { dismissLeadAction } from "@/lib/supabaseQueries";
import { updateLeadActionInstructions, getLeadActionInstructions } from "@/lib/repProfileQueries";
import { toast } from "sonner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface ActionRequiredPanelProps {
  leads: EnrichedLead[];
  onLeadUpdated?: () => void;
}

export function ActionRequiredPanel({ leads, onLeadUpdated }: ActionRequiredPanelProps) {
  const [selectedLead, setSelectedLead] = useState<EnrichedLead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [expandedInstructions, setExpandedInstructions] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [currentInstructions, setCurrentInstructions] = useState("");
  
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

  const handleOpenEmailDialog = async (lead: EnrichedLead) => {
    // Get instructions for this lead
    const leadInstructions = instructions[lead.id] || "";
    setCurrentInstructions(leadInstructions);
    setSelectedLead(lead);
    setDialogOpen(true);
  };

  const toggleInstructions = async (leadId: string) => {
    if (expandedInstructions === leadId) {
      // Collapsing - save instructions
      if (instructions[leadId]) {
        try {
          await updateLeadActionInstructions(leadId, instructions[leadId]);
        } catch (err) {
          console.error("Failed to save instructions:", err);
        }
      }
      setExpandedInstructions(null);
    } else {
      // Expanding - load instructions
      try {
        const saved = await getLeadActionInstructions(leadId);
        if (saved) {
          setInstructions(prev => ({ ...prev, [leadId]: saved }));
        }
      } catch (err) {
        console.error("Failed to load instructions:", err);
      }
      setExpandedInstructions(leadId);
    }
  };

  const updateInstructions = (leadId: string, value: string) => {
    setInstructions(prev => ({ ...prev, [leadId]: value }));
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
              className="p-3 bg-background rounded-lg border"
            >
              <div className="flex items-center justify-between">
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
              
              {/* Instructions Collapsible */}
              <Collapsible 
                open={expandedInstructions === lead.id} 
                onOpenChange={() => toggleInstructions(lead.id)}
              >
                <CollapsibleTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="w-full justify-start gap-2 text-xs text-muted-foreground mt-2 h-7"
                  >
                    {expandedInstructions === lead.id ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    <Lightbulb className="h-3 w-3" />
                    {instructions[lead.id] ? "Edit instructions" : "Add instructions"}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2">
                  <Input
                    value={instructions[lead.id] || ""}
                    onChange={(e) => updateInstructions(lead.id, e.target.value)}
                    placeholder="e.g., Already sent recap, just follow up on pricing..."
                    className="text-sm"
                  />
                </CollapsibleContent>
              </Collapsible>
            </div>
          ))}
        </CardContent>
      </Card>

      {selectedLead && (
        <EmailActionDialog
          lead={selectedLead}
          open={dialogOpen}
          initialInstructions={currentInstructions}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) {
              setSelectedLead(null);
              setCurrentInstructions("");
              onLeadUpdated?.();
            }
          }}
        />
      )}
    </>
  );
}
