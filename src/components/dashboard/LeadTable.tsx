import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Mail, FileText, Eye, Plus, Send, Lightbulb, Sparkles, ChevronRight, Loader2, Zap, RefreshCw, Trash2 } from "lucide-react";
import { EnrichedLead, STAGE_LABELS, DealStage, getActionType, STAGE_ORDER } from "@/lib/dashboardUtils";
import { EmailActionDialog } from "./EmailActionDialog";
import { NurtureSwitchDialog } from "./NurtureSwitchDialog";
import { LeadAvatar } from "./LeadAvatar";
import { updateLeadStage, bulkUpdateLeadStage, deleteLead } from "@/lib/supabaseQueries";
import { formatDistanceToNow, isToday, isYesterday, differenceInHours } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

// Format last email date with color coding
function formatLastEmail(dateStr: string | null): { text: string; className: string } {
  if (!dateStr) {
    return { text: "—", className: "text-muted-foreground italic" };
  }
  
  const date = new Date(dateStr);
  const hoursAgo = differenceInHours(new Date(), date);
  
  let text: string;
  if (isToday(date)) {
    text = "Today";
  } else if (isYesterday(date)) {
    text = "Yesterday";
  } else {
    text = formatDistanceToNow(date, { addSuffix: true });
  }
  
  // Color coding: green for recent (< 24h), muted for older
  const className = hoursAgo < 24 
    ? "text-success font-medium" 
    : "text-muted-foreground";
  
  return { text, className };
}

interface LeadTableProps {
  leads: EnrichedLead[];
  isLoading: boolean;
  onLeadUpdated?: () => void;
}

const stageBadgeVariants: Record<DealStage, string> = {
  new: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  contacted: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300 hover:bg-blue-200",
  engaged: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300 hover:bg-green-200",
  post_meeting: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300 hover:bg-purple-200",
  closing: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300 hover:bg-orange-200",
  closed_won: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300 hover:bg-emerald-200",
  closed_lost: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300 hover:bg-red-200",
};

const ALL_STAGES: DealStage[] = [...STAGE_ORDER, "closed_won", "closed_lost"];

export function LeadTable({ leads, isLoading, onLeadUpdated }: LeadTableProps) {
  const [selectedLead, setSelectedLead] = useState<EnrichedLead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [nurtureSwitchLead, setNurtureSwitchLead] = useState<EnrichedLead | null>(null);
  const [currentInstructions, setCurrentInstructions] = useState("");
  const [instructionsPopover, setInstructionsPopover] = useState<string | null>(null);
  const [tempInstructions, setTempInstructions] = useState("");
  const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
  const [updatingStage, setUpdatingStage] = useState<string | null>(null);
  const [updatingStrategy, setUpdatingStrategy] = useState<string | null>(null);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const navigate = useNavigate();

  const allSelected = leads.length > 0 && selectedLeads.size === leads.length;
  const someSelected = selectedLeads.size > 0 && selectedLeads.size < leads.length;

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedLeads(new Set(leads.map(l => l.id)));
    } else {
      setSelectedLeads(new Set());
    }
  };

  const handleSelectLead = (leadId: string, checked: boolean) => {
    const newSelected = new Set(selectedLeads);
    if (checked) {
      newSelected.add(leadId);
    } else {
      newSelected.delete(leadId);
    }
    setSelectedLeads(newSelected);
  };

  const handleStageChange = async (leadId: string, newStage: DealStage) => {
    setUpdatingStage(leadId);
    try {
      await updateLeadStage(leadId, newStage);
      toast.success(`Stage updated to ${STAGE_LABELS[newStage]}`);
      onLeadUpdated?.();
    } catch (err) {
      console.error("Failed to update stage:", err);
      toast.error("Failed to update stage");
    } finally {
      setUpdatingStage(null);
    }
  };

  const handleBulkStageChange = async (newStage: DealStage) => {
    if (selectedLeads.size === 0) return;
    
    setBulkUpdating(true);
    try {
      await bulkUpdateLeadStage(Array.from(selectedLeads), newStage);
      toast.success(`Updated ${selectedLeads.size} leads to ${STAGE_LABELS[newStage]}`);
      setSelectedLeads(new Set());
      onLeadUpdated?.();
    } catch (err) {
      console.error("Failed to bulk update stages:", err);
      toast.error("Failed to update stages");
    } finally {
      setBulkUpdating(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedLeads.size === 0) return;
    
    setBulkDeleting(true);
    try {
      // Delete leads one by one (or use batch delete if available)
      const deletePromises = Array.from(selectedLeads).map(id => deleteLead(id));
      await Promise.all(deletePromises);
      
      toast.success(`Deleted ${selectedLeads.size} lead${selectedLeads.size > 1 ? 's' : ''}`);
      setSelectedLeads(new Set());
      setDeleteDialogOpen(false);
      onLeadUpdated?.();
    } catch (err) {
      console.error("Failed to delete leads:", err);
      toast.error("Failed to delete some leads");
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleStrategyToggle = async (lead: EnrichedLead) => {
    const currentStrategy = (lead as any).strategy || "fast";
    
    // If switching TO nurture, open the dialog
    if (currentStrategy === "fast") {
      setNurtureSwitchLead(lead);
      return;
    }
    
    // If switching FROM nurture to fast
    setUpdatingStrategy(lead.id);
    try {
      const { error } = await supabase
        .from("leads")
        .update({
          strategy: "fast",
          nurture_cadence: null,
          mode_changed_at: new Date().toISOString(),
        })
        .eq("id", lead.id);

      if (error) throw error;

      toast.success(`Switched ${lead.name} to fast mode`);
      onLeadUpdated?.();
    } catch (err) {
      console.error("Failed to switch strategy:", err);
      toast.error("Failed to switch strategy");
    } finally {
      setUpdatingStrategy(null);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Leads</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (leads.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Leads</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">No leads match this filter</p>
            <Button asChild>
              <Link to="/dashboard/leads">
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Lead
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleOpenEmailDialog = (lead: EnrichedLead, instructions: string = "") => {
    setCurrentInstructions(instructions);
    setSelectedLead(lead);
    setDialogOpen(true);
    setInstructionsPopover(null);
  };

  const openInstructionsPopover = (leadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTempInstructions("");
    setInstructionsPopover(leadId);
  };

  const confirmInstructions = (lead: EnrichedLead) => {
    handleOpenEmailDialog(lead, tempInstructions);
  };

  // Small mail icon - opens composer directly (no popover)
  // Uses history-aware mode: if lead has email history, prepare reply; otherwise intro
  const renderEmailComposeButton = (lead: EnrichedLead) => (
    <Button 
      size="sm" 
      variant="ghost" 
      onClick={(e) => {
        e.stopPropagation();
        // Open composer directly without instruction popover
        handleOpenEmailDialog(lead, "");
      }}
      title={lead.last_outbound_at ? "Compose reply" : "Compose intro email"}
    >
      <Mail className="h-4 w-4" />
    </Button>
  );

  const renderViewButton = (lead: EnrichedLead) => (
    <Button size="sm" variant="ghost" asChild>
      <Link to={`/dashboard/leads/${lead.id}`}>
        <Eye className="h-4 w-4" />
      </Link>
    </Button>
  );

  const getActionButton = (lead: EnrichedLead) => {
    const actionType = getActionType(lead.next_action_key);

    // New leads without action get Smart Intro button
    if (lead.stage === "new" && !lead.needs_action) {
      return (
        <div className="flex items-center gap-1">
          <Popover 
            open={instructionsPopover === lead.id} 
            onOpenChange={(open) => !open && setInstructionsPopover(null)}
          >
            <PopoverTrigger asChild>
              <Button 
                size="sm" 
                variant="default" 
                onClick={(e) => openInstructionsPopover(lead.id, e)}
              >
                <Sparkles className="h-4 w-4 mr-1" />
                Draft
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80" align="end">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-warning" />
                  <span className="text-sm font-medium">Add instructions (optional)</span>
                </div>
                <Input
                  value={tempInstructions}
                  onChange={(e) => setTempInstructions(e.target.value)}
                  placeholder="e.g., Mention the healthcare conference..."
                  className="text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      confirmInstructions(lead);
                    }
                  }}
                />
                <div className="flex justify-end gap-2">
                  <Button 
                    size="sm" 
                    variant="ghost" 
                    onClick={() => setInstructionsPopover(null)}
                  >
                    Cancel
                  </Button>
                  <Button 
                    size="sm" 
                    onClick={() => confirmInstructions(lead)}
                  >
                    Generate Draft
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          {renderEmailComposeButton(lead)}
          {renderViewButton(lead)}
        </div>
      );
    }

    if (lead.needs_action) {
      const ActionIcon = actionType === "reply" ? Mail 
        : actionType === "nurture" ? Send 
        : FileText;
      const actionLabel = actionType === "reply" ? "Reply" 
        : actionType === "nurture" ? "Send" 
        : "Draft";

      return (
        <div className="flex items-center gap-1">
          <Popover 
            open={instructionsPopover === lead.id} 
            onOpenChange={(open) => !open && setInstructionsPopover(null)}
          >
            <PopoverTrigger asChild>
              <Button 
                size="sm" 
                variant="default" 
                onClick={(e) => openInstructionsPopover(lead.id, e)}
              >
                <ActionIcon className="h-4 w-4 mr-1" />
                {actionLabel}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80" align="end">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-warning" />
                  <span className="text-sm font-medium">Add instructions (optional)</span>
                </div>
                <Input
                  value={tempInstructions}
                  onChange={(e) => setTempInstructions(e.target.value)}
                  placeholder="e.g., Already sent recap, follow up on pricing..."
                  className="text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      confirmInstructions(lead);
                    }
                  }}
                />
                <div className="flex justify-end gap-2">
                  <Button 
                    size="sm" 
                    variant="ghost" 
                    onClick={() => setInstructionsPopover(null)}
                  >
                    Cancel
                  </Button>
                  <Button 
                    size="sm" 
                    onClick={() => confirmInstructions(lead)}
                  >
                    Generate {actionLabel}
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          {renderEmailComposeButton(lead)}
          {renderViewButton(lead)}
        </div>
      );
    }

    // Default: just email compose + view
    return (
      <div className="flex items-center gap-1">
        {renderEmailComposeButton(lead)}
        {renderViewButton(lead)}
      </div>
    );
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Leads</CardTitle>
            {selectedLeads.size > 0 && (
              <div className="flex items-center gap-2 animate-fade-in">
                <span className="text-sm text-muted-foreground">
                  {selectedLeads.size} selected
                </span>
                <Select
                  onValueChange={(value) => handleBulkStageChange(value as DealStage)}
                  disabled={bulkUpdating || bulkDeleting}
                >
                  <SelectTrigger className="w-[160px] h-8">
                    <SelectValue placeholder="Move to stage..." />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_STAGES.map((stage) => (
                      <SelectItem key={stage} value={stage}>
                        {STAGE_LABELS[stage]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                  <AlertDialogTrigger asChild>
                    <Button 
                      variant="destructive" 
                      size="sm"
                      disabled={bulkUpdating || bulkDeleting}
                      className="h-8"
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {selectedLeads.size} lead{selectedLeads.size > 1 ? 's' : ''}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This action cannot be undone. All associated interactions, drafts, and meeting packs will also be deleted.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
                      <AlertDialogAction 
                        onClick={handleBulkDelete}
                        disabled={bulkDeleting}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {bulkDeleting ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Deleting...
                          </>
                        ) : (
                          <>
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </>
                        )}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                
                {(bulkUpdating || bulkDeleting) && <Loader2 className="h-4 w-4 animate-spin" />}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={handleSelectAll}
                    aria-label="Select all"
                    className={cn(someSelected && "data-[state=checked]:bg-primary/50")}
                  />
                </TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead className="hidden sm:table-cell">Mode</TableHead>
                <TableHead className="hidden md:table-cell">Last Email</TableHead>
                <TableHead className="hidden lg:table-cell">Next Action</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead, index) => {
                const lastEmail = formatLastEmail(lead.last_outbound_at);
                const isSelected = selectedLeads.has(lead.id);
                const isUpdatingThis = updatingStage === lead.id;
                const isUpdatingStrategyThis = updatingStrategy === lead.id;
                const strategy = (lead as any).strategy || "fast";
                const nurtureCadence = (lead as any).nurture_cadence;
                
                return (
                  <TableRow
                    key={lead.id}
                    className={cn(
                      "cursor-pointer transition-colors group",
                      isSelected && "bg-muted/50",
                      index % 2 === 1 && !isSelected && "bg-muted/20"
                    )}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button, a, [role='dialog'], input, [role='combobox']")) return;
                      navigate(`/dashboard/leads/${lead.id}`);
                    }}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(checked) => handleSelectLead(lead.id, !!checked)}
                        aria-label={`Select ${lead.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <LeadAvatar 
                          name={lead.name} 
                          company={lead.company} 
                          leadId={lead.id}
                          size="sm"
                        />
                        <div>
                          <p className="font-medium text-foreground">{lead.name}</p>
                          <p className="text-sm text-muted-foreground">{lead.company}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Select
                        value={lead.stage}
                        onValueChange={(value) => handleStageChange(lead.id, value as DealStage)}
                        disabled={isUpdatingThis}
                      >
                        <SelectTrigger 
                          className={cn(
                            "w-[130px] h-7 border-0 font-medium text-xs",
                            stageBadgeVariants[lead.stage]
                          )}
                        >
                          {isUpdatingThis ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <SelectValue />
                          )}
                        </SelectTrigger>
                        <SelectContent>
                          {ALL_STAGES.map((stage) => (
                            <SelectItem key={stage} value={stage}>
                              {STAGE_LABELS[stage]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "h-7 px-2 text-xs font-medium gap-1",
                          strategy === "fast" 
                            ? "text-info hover:bg-info/10" 
                            : "text-primary hover:bg-primary/10"
                        )}
                        onClick={() => handleStrategyToggle(lead)}
                        disabled={isUpdatingStrategyThis}
                      >
                        {isUpdatingStrategyThis ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : strategy === "fast" ? (
                          <>
                            <Zap className="h-3 w-3" />
                            Fast
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-3 w-3" />
                            {nurtureCadence ? nurtureCadence.charAt(0).toUpperCase() + nurtureCadence.slice(1) : "Nurture"}
                          </>
                        )}
                      </Button>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <span className={`text-sm ${lastEmail.className}`}>
                        {lastEmail.text}
                      </span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <p className="text-sm text-muted-foreground truncate max-w-[200px]">
                        {lead.next_action_label || (lead.stage === "new" ? "Ready for outreach" : "—")}
                      </p>
                    </TableCell>
                    <TableCell className="text-right">{getActionButton(lead)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
