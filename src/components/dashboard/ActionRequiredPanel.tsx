import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { 
  AlertCircle, Mail, FileText, Eye, Send, X, Lightbulb, 
  ChevronDown, ChevronRight, MoreHorizontal, Clock, RefreshCw
} from "lucide-react";
import { EnrichedLead, getActionType } from "@/lib/dashboardUtils";
import { EmailActionDialog } from "./EmailActionDialog";
import { NurtureSwitchDialog } from "./NurtureSwitchDialog";
import { dismissLeadAction, getLatestInboundEmail, EmailPreviewSnippet } from "@/lib/supabaseQueries";
import { updateLeadActionInstructions, getLeadActionInstructions } from "@/lib/repProfileQueries";
import { toast } from "sonner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

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
  const [expandedInstructions, setExpandedInstructions] = useState<string | null>(null);
  const [expandedPreview, setExpandedPreview] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [currentInstructions, setCurrentInstructions] = useState("");
  const [emailPreviews, setEmailPreviews] = useState<Record<string, EmailPreviewSnippet | null>>({});
  const [loadingPreviews, setLoadingPreviews] = useState<Record<string, boolean>>({});
  
  const actionLeads = leads.filter((l) => l.needs_action).slice(0, 5);

  const handleDismiss = async (lead: EnrichedLead, reasonCode: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
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

  const toggleEmailPreview = async (leadId: string) => {
    if (expandedPreview === leadId) {
      setExpandedPreview(null);
      return;
    }
    
    setExpandedPreview(leadId);
    
    // Load preview if not already loaded
    if (!emailPreviews[leadId] && !loadingPreviews[leadId]) {
      setLoadingPreviews(prev => ({ ...prev, [leadId]: true }));
      try {
        const preview = await getLatestInboundEmail(leadId);
        setEmailPreviews(prev => ({ ...prev, [leadId]: preview }));
      } catch (err) {
        console.error("Failed to load email preview:", err);
      } finally {
        setLoadingPreviews(prev => ({ ...prev, [leadId]: false }));
      }
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
    const actionReasonCode = (lead as any).action_reason_code;
    
    // Special handling for nurture switch recommendation
    if (actionReasonCode === "NURTURE_SWITCH_RECOMMENDED") {
      return (
        <Button 
          size="sm" 
          variant="outline"
          className="border-primary text-primary hover:bg-primary hover:text-primary-foreground"
          onClick={() => setNurtureSwitchLead(lead)}
        >
          <RefreshCw className="h-4 w-4 mr-1" />
          Switch to Nurture
        </Button>
      );
    }

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
      <Card className="border-warning/30 bg-gradient-to-br from-warning/5 to-transparent">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <div className="p-1.5 rounded-md bg-warning/10">
              <AlertCircle className="h-5 w-5 text-warning" />
            </div>
            Action Required
            <span className="ml-auto text-sm font-normal text-muted-foreground">
              {actionLeads.length} pending
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {actionLeads.map((lead, index) => {
            const actionType = getActionType(lead.next_action_key);
            const showPreviewOption = actionType === "reply";
            const preview = emailPreviews[lead.id];
            const isLoadingPreview = loadingPreviews[lead.id];
            
            return (
              <div
                key={lead.id}
                className={cn(
                  "p-3 bg-background rounded-lg border transition-all duration-200 animate-fade-in",
                  "hover:shadow-sm"
                )}
                style={{ animationDelay: `${index * 50}ms` }}
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
                    
                    {/* Dismiss with reason dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={dismissingId === lead.id}
                        >
                          {dismissingId === lead.id ? (
                            <span className="animate-pulse-subtle">...</span>
                          ) : (
                            <X className="h-4 w-4" />
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                          Dismiss because...
                        </p>
                        {DISMISS_REASONS.map((reason) => (
                          <DropdownMenuItem
                            key={reason.code}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDismiss(lead, reason.code);
                            }}
                          >
                            {reason.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                
                {/* Email Preview (for reply actions) */}
                {showPreviewOption && (
                  <Collapsible 
                    open={expandedPreview === lead.id} 
                    onOpenChange={() => toggleEmailPreview(lead.id)}
                  >
                    <CollapsibleTrigger asChild>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="w-full justify-start gap-2 text-xs text-muted-foreground mt-2 h-7"
                      >
                        {expandedPreview === lead.id ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        <Mail className="h-3 w-3" />
                        {preview ? "Hide email preview" : "Show last email"}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2">
                      {isLoadingPreview ? (
                        <div className="p-3 bg-muted/50 rounded-md text-sm text-muted-foreground animate-pulse">
                          Loading...
                        </div>
                      ) : preview ? (
                        <div className="p-3 bg-muted/50 rounded-md space-y-1.5">
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span className="font-medium truncate max-w-[200px]">
                              From: {preview.from_email || "Unknown"}
                            </span>
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatDistanceToNow(new Date(preview.occurred_at), { addSuffix: true })}
                            </span>
                          </div>
                          {preview.subject && (
                            <p className="text-xs font-medium text-foreground truncate">
                              {preview.subject}
                            </p>
                          )}
                          <p className="text-sm text-muted-foreground line-clamp-3">
                            {preview.body_text.slice(0, 200)}
                            {preview.body_text.length > 200 && "..."}
                          </p>
                        </div>
                      ) : (
                        <div className="p-3 bg-muted/50 rounded-md text-sm text-muted-foreground">
                          No inbound email found
                        </div>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                )}
                
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
            );
          })}
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
