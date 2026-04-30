import { useState, useMemo, useCallback, useEffect } from "react";
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
import { Mail, FileText, Eye, Plus, Send, Lightbulb, Sparkles, ChevronRight, ChevronDown, Loader2, Zap, RefreshCw, Trash2, Leaf, Search, AlertTriangle, MessageSquare, Wand2, Check } from "lucide-react";
import { EnrichedLead, STAGE_LABELS, DealStage, getActionType, STAGE_ORDER, SOURCE_TYPE_LABELS, SOURCE_TYPE_COLORS, SourceType } from "@/lib/dashboardUtils";
import { EmailActionDialog } from "./EmailActionDialog";
import { NurtureSwitchDialog } from "./NurtureSwitchDialog";
import { BulkAutomationDialog } from "./BulkAutomationDialog";
import { LeadAvatar } from "./LeadAvatar";
import { ModeDropdown } from "./ModeDropdown";
import { SourceDropdown } from "./SourceDropdown";
import { updateSourceFromTable, type SourcePresetKey } from "@/lib/motionUpdater";
import { updateLeadStage, bulkUpdateLeadStage, deleteLead } from "@/lib/supabaseQueries";
import { formatDistanceToNow, isToday, isYesterday, differenceInHours } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBackgroundDraftQueue } from "@/hooks/useBackgroundDraftQueue";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

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

import { calculateClosingPower, type ScoreBreakdown } from "@/lib/closingPowerUtils";
import type { LeadDetail } from "@/lib/supabaseQueries";

// WA indicator: icon + pending reply speed + acceleration badge
function WaIndicator({ lead }: { lead: EnrichedLead }) {
  const lastInbound = (lead as any).last_inbound_at as string | null;
  const lastOutbound = (lead as any).last_outbound_at as string | null;
  const nextActionKey = (lead as any).next_action_key as string | null;
  const accelerationUntil = (lead as any).acceleration_until as string | null;
  const isAccelerating = accelerationUntil && new Date(accelerationUntil) > new Date();
  const isWaActive = nextActionKey === "whatsapp_reply" || nextActionKey === "whatsapp_failed";
  if (!isWaActive && !lastInbound && !isAccelerating) return null;

  // Countdown for acceleration mode
  let countdownLabel: string | null = null;
  if (isAccelerating && accelerationUntil) {
    const msLeft = new Date(accelerationUntil).getTime() - Date.now();
    const hoursLeft = Math.ceil(msLeft / (1000 * 60 * 60));
    countdownLabel = hoursLeft > 0 ? `${hoursLeft}h` : null;
  }

  let speedLabel: string | null = null;
  let speedClass = "text-muted-foreground";
  if (lastInbound) {
    const inTs = new Date(lastInbound).getTime();
    const outTs = lastOutbound ? new Date(lastOutbound).getTime() : 0;
    if (inTs > outTs) {
      const hrsWaiting = differenceInHours(new Date(), new Date(lastInbound));
      if (hrsWaiting >= 6) {
        speedLabel = `${hrsWaiting}h`;
        speedClass = hrsWaiting >= 24 ? "text-destructive" : "text-warning";
      }
    }
  }
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" title={isAccelerating ? `🚀 Acceleration Mode — ${countdownLabel} remaining` : "WhatsApp active"}>
      <MessageSquare className="h-3 w-3 text-[hsl(var(--success))]" />
      {isAccelerating && (
        <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-primary/10 text-primary border border-primary/20">
          🚀 {countdownLabel}
        </span>
      )}
      {!isAccelerating && speedLabel && (
        <span className={cn("text-[9px] font-semibold tabular-nums", speedClass)}>{speedLabel}</span>
      )}
    </span>
  );
}



// Bridge EnrichedLead → LeadDetail shape for calculateClosingPower
function getClosingScore(lead: EnrichedLead): number {
  return getClosingBreakdown(lead).total;
}

function getClosingBreakdown(lead: EnrichedLead): ScoreBreakdown {
  const asDetail = {
    ...lead,
    has_future_meeting: lead.has_future_meeting ?? lead.hasMeeting,
    milestones_json: lead.milestones_json ?? null,
    risks_json: lead.risks_json ?? null,
    deal_outlook: lead.deal_outlook ?? null,
    last_inbound_at: lead.last_inbound_at ?? null,
    last_outbound_at: lead.last_outbound_at ?? null,
    last_activity_at: lead.last_activity_at ?? null,
  } as unknown as LeadDetail;
  return calculateClosingPower(asDetail);
}

// Derive structured engagement + progress signals for heating_up rows
function getAccelerationLines(lead: EnrichedLead, breakdown: ScoreBreakdown): [string, string] {
  const engagementLabels = ["Fast reply (<24h)", "Meeting booked", "WhatsApp engaged", "WhatsApp inbound"];
  const progressLabels = ["Pricing mentioned", "Decision maker involved", "Docs requested", "Closing stage"];

  const positive = breakdown.factors.filter(f => f.points > 0);
  const engagement = positive.find(f => engagementLabels.includes(f.label))?.label || null;
  const progress = positive.find(f => progressLabels.includes(f.label))?.label || null;

  return [
    engagement || "Engagement trending upward",
    progress || "Engagement increasing",
  ];
}

interface LeadTableProps {
  leads: EnrichedLead[];
  isLoading: boolean;
  onLeadUpdated?: () => void;
  revenueStateFilter?: string;
}

const stageBadgeVariants: Record<DealStage, string> = {
  new: "bg-muted/60 text-muted-foreground",
  contacted: "bg-primary/10 text-primary",
  engaged: "bg-success/10 text-success",
  post_meeting: "bg-secondary/15 text-secondary",
  closing: "bg-warning/10 text-warning",
  closed_won: "bg-success/15 text-success",
  closed_lost: "bg-destructive/10 text-destructive",
};

const ALL_STAGES: DealStage[] = [...STAGE_ORDER, "closed_won", "closed_lost"];

export function LeadTable({ leads, isLoading, onLeadUpdated, revenueStateFilter }: LeadTableProps) {
  // Memoize closing scores + breakdowns for heating_up
  const scoreMap = useMemo(() => {
    if (revenueStateFilter !== "heating_up") return new Map<string, number>();
    const map = new Map<string, number>();
    for (const lead of leads) {
      map.set(lead.id, getClosingScore(lead));
    }
    return map;
  }, [leads, revenueStateFilter]);

  const breakdownMap = useMemo(() => {
    if (revenueStateFilter !== "heating_up") return new Map<string, ScoreBreakdown>();
    const map = new Map<string, ScoreBreakdown>();
    for (const lead of leads) {
      map.set(lead.id, getClosingBreakdown(lead));
    }
    return map;
  }, [leads, revenueStateFilter]);

  const [searchQuery, setSearchQuery] = useState("");
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
  const [bulkSourceUpdating, setBulkSourceUpdating] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [bulkAutomationOpen, setBulkAutomationOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const PAGE_SIZE = 25;
  const navigate = useNavigate();
  const { enqueue, getStatus, consume } = useBackgroundDraftQueue();

  // Reset pagination when underlying data or search changes
  useEffect(() => { setPageIndex(0); }, [leads.length, searchQuery, revenueStateFilter]);

  // Pre-generate button handler
  const handlePreGenerate = useCallback((lead: EnrichedLead, e: React.MouseEvent) => {
    e.stopPropagation();
    const status = getStatus(lead.id);
    if (status?.status === "generating") return; // already generating
    if (status?.status === "ready") {
      // Draft is ready — open dialog with prefilled content
      const entry = consume(lead.id);
      if (entry?.result) {
        setCurrentInstructions("");
        setSelectedLead({
          ...lead,
          _prefilledBody: entry.result.draft_text,
          _prefilledSubject: entry.result.suggested_subject || entry.subject,
        } as any);
        setDialogOpen(true);
      }
      return;
    }
    // Start background generation
    enqueue(lead.id);
  }, [getStatus, consume, enqueue]);

  const allSelected = leads.length > 0 && selectedLeads.size === leads.length;
  const someSelected = selectedLeads.size > 0 && selectedLeads.size < leads.length;

  // Filtered + sorted leads (search + heating_up sort)
  const visibleLeads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let arr = leads;
    if (q) {
      arr = arr.filter((l) => l.name.toLowerCase().includes(q) || l.company.toLowerCase().includes(q));
    }
    if (revenueStateFilter === "heating_up") {
      arr = [...arr].sort((a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0));
    }
    return arr;
  }, [leads, searchQuery, revenueStateFilter, scoreMap]);

  const totalCount = visibleLeads.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const pageLeads = useMemo(() => {
    if (showAll) return visibleLeads;
    const start = safePageIndex * PAGE_SIZE;
    return visibleLeads.slice(start, start + PAGE_SIZE);
  }, [visibleLeads, safePageIndex, showAll]);

  const pageIds = useMemo(() => new Set(pageLeads.map((l) => l.id)), [pageLeads]);
  const selectedOnPage = useMemo(() => pageLeads.filter((l) => selectedLeads.has(l.id)).length, [pageLeads, selectedLeads]);
  const allOnPageSelected = pageLeads.length > 0 && selectedOnPage === pageLeads.length;
  const someOnPageSelected = selectedOnPage > 0 && selectedOnPage < pageLeads.length;

  const handleSelectAll = (checked: boolean) => {
    const next = new Set(selectedLeads);
    if (checked) {
      pageIds.forEach((id) => next.add(id));
    } else {
      pageIds.forEach((id) => next.delete(id));
    }
    setSelectedLeads(next);
  };

  const handleSelectAllFiltered = () => {
    setSelectedLeads(new Set(visibleLeads.map((l) => l.id)));
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
          nurture_mode: "review",
          nurture_status: "inactive",
          nurture_theme: null,
          auto_nurture_eligible: false,
          motion: (lead as any).last_inbound_at ? "inbound_response" : "outbound_prospecting",
          needs_action: false,
          next_action_key: null,
          next_action_label: null,
          action_reason_code: null,
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
              <Link to="/app/leads">
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
      <Link to={`/app/leads/${lead.id}`} state={{ originContext: "dashboard" }}>
        <Eye className="h-4 w-4" />
      </Link>
    </Button>
  );

  const getActionButton = (lead: EnrichedLead) => {
    const actionType = getActionType(lead.next_action_key);

    // New leads without action get Smart Intro button
    if (lead.stage === "new" && !lead.needs_action) {
      return (
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
      );
    }

    // Needs action
    if (lead.needs_action && lead.next_action_key) {
      const labelMap: Record<string, string> = {
        reply: "Reply",
        follow_up: "Follow Up",
        recap: "Recap",
        nurture: "Nurture",
        closing: "Close",
        view: "View",
      };
      const iconMap: Record<string, React.ReactNode> = {
        reply: <Mail className="h-4 w-4 mr-1" />,
        follow_up: <Send className="h-4 w-4 mr-1" />,
        recap: <FileText className="h-4 w-4 mr-1" />,
        nurture: <Leaf className="h-4 w-4 mr-1" />,
        closing: <Sparkles className="h-4 w-4 mr-1" />,
        view: <Eye className="h-4 w-4 mr-1" />,
      };
      const label = labelMap[actionType] || "Action";
      const icon = iconMap[actionType] || null;
      return (
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
              {icon}
              <span>{label}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80" align="end" onClick={(e) => e.stopPropagation()}>
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
                <Button size="sm" variant="ghost" onClick={() => setInstructionsPopover(null)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => confirmInstructions(lead)}>
                  Continue
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      );
    }

    // Default — no action needed
    return null;
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Leads</CardTitle>
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name or company..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
          </div>
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

                <Select
                  onValueChange={async (value) => {
                    const key = value as SourcePresetKey;
                    if (selectedLeads.size === 0) return;
                    setBulkSourceUpdating(true);
                    let successCount = 0;
                    for (const id of selectedLeads) {
                      const ok = await updateSourceFromTable(id, key);
                      if (ok) successCount++;
                    }
                    setBulkSourceUpdating(false);
                    if (successCount > 0) {
                      toast.success(`Updated source for ${successCount} lead${successCount > 1 ? 's' : ''}`);
                      setSelectedLeads(new Set());
                      onLeadUpdated?.();
                    } else {
                      toast.error("Failed to update sources");
                    }
                  }}
                  disabled={bulkUpdating || bulkDeleting || bulkSourceUpdating}
                >
                  <SelectTrigger className="w-[170px] h-8">
                    <SelectValue placeholder="Change source..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="outbound">Outbound Prospect</SelectItem>
                    <SelectItem value="inbound_website">Inbound – Website</SelectItem>
                    <SelectItem value="event">Event Lead</SelectItem>
                    <SelectItem value="referral">Referral</SelectItem>
                    <SelectItem value="other">Manual</SelectItem>
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

                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={bulkUpdating || bulkDeleting}
                  onClick={() => setBulkAutomationOpen(true)}
                >
                  <Zap className="h-4 w-4 mr-1" />
                  Enable Automation
                </Button>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      disabled={bulkUpdating || bulkDeleting || selectedLeads.size === 0}
                    >
                      <Leaf className="h-4 w-4 mr-1" />
                      Move to Nurture
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Move {selectedLeads.size} lead{selectedLeads.size === 1 ? "" : "s"} to nurture?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Each selected lead will be switched to the <strong>biweekly nurture cadence</strong> in <strong>review mode</strong>.
                        The first nurture email will be queued for review (not auto-sent). You can change cadence or stop nurture per lead afterwards.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={bulkUpdating}>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={async () => {
                          const selectedIds = Array.from(selectedLeads);
                          if (selectedIds.length === 0) return;
                          setBulkUpdating(true);
                          try {
                            const { getNurtureCadenceDays } = await import("@/lib/cadenceSettingsTypes");
                            const gapDays = getNurtureCadenceDays("biweekly");
                            let eligibleAt = new Date();
                            eligibleAt.setDate(eligibleAt.getDate() + gapDays);
                            eligibleAt.setHours(9, 30, 0, 0);
                            if (eligibleAt.getTime() <= Date.now()) {
                              eligibleAt.setDate(eligibleAt.getDate() + 1);
                            }

                            const updates = selectedIds.map((id) =>
                              supabase
                                .from("leads")
                                .update({
                                  motion: "nurture",
                                  nurture_status: "active",
                                  nurture_mode: "review",
                                  nurture_cadence: "biweekly",
                                  needs_action: false,
                                  next_action_key: "nurture_1",
                                  next_action_label: "Nurture Email 1",
                                  eligible_at: eligibleAt.toISOString(),
                                  action_reason_code: "NURTURE_DUE",
                                  mode_changed_at: new Date().toISOString(),
                                })
                                .eq("id", id)
                            );
                            const results = await Promise.all(updates);
                            const errors = results.filter((r) => r.error);
                            if (errors.length > 0) {
                              toast.error(`Failed to update ${errors.length} lead(s)`);
                            } else {
                              toast.success(`${selectedIds.length} lead${selectedIds.length > 1 ? "s" : ""} moved to Nurture`);
                            }
                            setSelectedLeads(new Set());
                            onLeadUpdated?.();
                          } catch (err) {
                            console.error("Bulk nurture failed:", err);
                            toast.error("Failed to move leads to nurture");
                          } finally {
                            setBulkUpdating(false);
                          }
                        }}
                      >
                        <Leaf className="h-4 w-4 mr-1" />
                        Move to Nurture
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                
                {(bulkUpdating || bulkDeleting || bulkSourceUpdating) && <Loader2 className="h-4 w-4 animate-spin" />}
              </div>
            )}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="text-xs border-b border-border/60">
                <TableHead className="w-1 p-0" />
                {revenueStateFilter === "heating_up" && (
                  <TableHead className="w-[40px] min-w-[40px] py-1.5 px-0 text-center text-[10px] text-muted-foreground/50">#</TableHead>
                )}
                <TableHead className="w-10 py-1.5">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={handleSelectAll}
                    aria-label="Select all"
                    className={cn(someSelected && "data-[state=checked]:bg-primary/50")}
                  />
                </TableHead>
                <TableHead className={cn(revenueStateFilter === "heating_up" ? "py-1.5 w-[320px] max-w-[320px]" : "py-2")}>Lead</TableHead>
                {revenueStateFilter === "heating_up" && (
                  <TableHead className="py-1.5 text-right w-[90px] min-w-[90px] pr-6">
                    <span className="inline-flex items-center gap-0.5">
                      Score
                      <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    </span>
                  </TableHead>
                )}
                {revenueStateFilter !== "heating_up" && (
                  <TableHead className="py-2">Phase</TableHead>
                )}
                <TableHead className={cn(revenueStateFilter === "heating_up" ? "py-1.5 w-[140px] min-w-[140px] pl-6" : "py-2", "hidden md:table-cell")}>Last Activity</TableHead>
                <TableHead className={cn(revenueStateFilter === "heating_up" ? "py-1.5 w-[160px] min-w-[160px]" : "py-2", "hidden lg:table-cell")}>Next Action</TableHead>
                {revenueStateFilter !== "heating_up" && (
                  <TableHead className="py-2 hidden lg:table-cell">Automation</TableHead>
                )}
                {revenueStateFilter === "action_required" && (
                  <TableHead className="py-2 text-right">Action</TableHead>
                )}
                {revenueStateFilter === "heating_up" && (
                  <TableHead className="py-1.5 w-[80px] min-w-[80px] text-right">Action</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.filter((l) => {
                if (!searchQuery) return true;
                const q = searchQuery.toLowerCase();
                return l.name.toLowerCase().includes(q) || l.company.toLowerCase().includes(q);
              })
              .sort((a, b) => revenueStateFilter === "heating_up" ? (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0) : 0)
              .map((lead, index) => {
                const isHeatingUp = revenueStateFilter === "heating_up";
                const lastEmail = formatLastEmail(lead.last_activity_at);
                const isSelected = selectedLeads.has(lead.id);
                const nurtureMode = (lead as any).nurture_mode;
                const nurtureStatus = (lead as any).nurture_status;
                const hasEligibleAt = !!(lead as any).eligible_at;
                // Active: has eligible_at + needs_action, OR nurture auto mode
                const isAutoRunning = (hasEligibleAt && lead.needs_action) || (nurtureMode === "auto" && nurtureStatus === "active");
                const isReview = !isAutoRunning && nurtureMode === "review" && nurtureStatus === "active";

                // Direction indicator based on activity recency
                const directionArrow = (() => {
                  if (lead.stage === "closed_won" || lead.stage === "closed_lost") return "";
                  if (!lead.last_activity_at) return "";
                  const daysSince = (Date.now() - new Date(lead.last_activity_at).getTime()) / (1000 * 60 * 60 * 24);
                  if (daysSince <= 3 && (lead.last_inbound_at || lead.stage !== "new")) return " ↑";
                  if (daysSince > 14) return " ↓";
                  return " →";
                })();

                return (
                  <TableRow
                    key={lead.id}
                    className={cn(
                      "cursor-pointer transition-colors duration-150",
                      "hover:bg-accent/30",
                      isSelected && "bg-accent/20",
                    )}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button, a, [role='dialog'], input, [role='combobox']")) return;
                      navigate(`/app/leads/${lead.id}`, { state: { originContext: "dashboard" } });
                    }}
                  >
                    {/* Color bar */}
                    <td className="w-0 p-0 relative">
                      <div className={cn(
                        "absolute left-0 top-0 bottom-0 w-1 rounded-r",
                        SOURCE_TYPE_COLORS[lead.source_type]?.bar || "bg-muted-foreground/30"
                      )} />
                    </td>
                    {/* Ranking index (heating_up only) */}
                    {isHeatingUp && (
                      <td className="w-[40px] min-w-[40px] px-0 text-center py-2">
                        <span className="text-[10px] tabular-nums text-muted-foreground/40">{index + 1}</span>
                      </td>
                    )}
                    <TableCell className={cn("py-2")} onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(checked) => handleSelectLead(lead.id, !!checked)}
                        aria-label={`Select ${lead.name}`}
                      />
                    </TableCell>

                    {/* Lead */}
                    <TableCell className={cn(isHeatingUp ? "py-2 w-[320px] max-w-[320px]" : "py-2")}>
                      <div className="flex items-center gap-2">
                        <LeadAvatar name={lead.name} company={lead.company} leadId={lead.id} size="sm" />
                        {isHeatingUp ? (
                          <div className="min-w-0 flex-1 overflow-hidden flex">
                            {/* 60% name/company */}
                            <div className="w-[60%] min-w-0 pr-2">
                              <div className="flex items-center gap-1 min-w-0">
                                <p className="text-sm font-medium text-foreground truncate">{lead.name}</p>
                                {(lead as any).unsubscribed && (
                                  <span className="inline-flex items-center gap-0.5 shrink-0 px-1 py-0 rounded text-[9px] font-semibold bg-destructive/10 text-destructive border border-destructive/20">
                                    <AlertTriangle className="h-2.5 w-2.5" />
                                    Bounced
                                  </span>
                                )}
                                <WaIndicator lead={lead} />
                              </div>
                              <p className="text-xs text-muted-foreground truncate">{lead.company}</p>
                            </div>
                            {/* 40% acceleration signals */}
                            <div className="w-[40%] min-w-0 flex flex-col justify-center gap-[2px]">
                              {(() => {
                                const bd = breakdownMap.get(lead.id);
                                const [engagement, progress] = bd ? getAccelerationLines(lead, bd) : ["Engagement trending upward", "Engagement increasing"];
                                return (
                                  <>
                                    <p className="text-[10px] leading-tight text-muted-foreground/60 truncate">{engagement}</p>
                                    <p className="text-[10px] leading-tight text-muted-foreground/60 truncate">{progress}</p>
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                        ) : (
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">{lead.name}</p>
                              {(lead as any).unsubscribed && (
                                <span className="inline-flex items-center gap-0.5 shrink-0 px-1 py-0 rounded text-[9px] font-semibold bg-destructive/10 text-destructive border border-destructive/20">
                                  <AlertTriangle className="h-2.5 w-2.5" />
                                  Bounced
                                </span>
                              )}
                              <WaIndicator lead={lead} />
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{lead.company}</p>
                          </div>
                        )}
                      </div>
                    </TableCell>

                    {isHeatingUp && (
                      <TableCell className="py-2 text-right w-[90px] min-w-[90px] pr-6 align-middle">
                        {(() => {
                          const s = scoreMap.get(lead.id) ?? 0;
                          const isTop3 = index < 3;
                          const color = isTop3
                            ? "text-foreground brightness-110"
                            : s >= 60 ? "text-foreground/90" : s < 40 ? "text-muted-foreground" : "text-foreground/70";
                          return (
                            <span className={cn("text-[15px] font-medium tabular-nums", color)}>{s}</span>
                          );
                        })()}
                      </TableCell>
                    )}

                    {/* Phase (hidden in heating_up) */}
                    {revenueStateFilter !== "heating_up" && (
                      <TableCell className="py-2" onClick={(e) => e.stopPropagation()}>
                        <ModeDropdown
                          leadId={lead.id}
                          leadName={lead.name}
                          currentPhase={lead.displayPhase}
                          directionArrow={directionArrow}
                          onNurtureSelect={() => setNurtureSwitchLead(lead)}
                          onUpdated={onLeadUpdated}
                        />
                      </TableCell>
                    )}

                    {/* Last Activity */}
                    <TableCell className={cn(isHeatingUp ? "py-2 pl-6" : "py-2", "hidden md:table-cell")}>
                      <span className={cn("text-xs", lastEmail.className)}>
                        {lastEmail.text}
                      </span>
                    </TableCell>

                    {/* Next Action */}
                    <TableCell className={cn("py-2", "hidden lg:table-cell")}>
                      <p className="text-xs text-muted-foreground truncate max-w-[180px]">
                        {lead.next_action_label || (lead.stage === "new" ? "Ready for outreach" : "—")}
                      </p>
                    </TableCell>

                    {/* Automation Status */}
                    {revenueStateFilter !== "heating_up" && (
                      <TableCell className="py-2 hidden lg:table-cell">
                        <div className="flex items-center gap-1">
                          {isAutoRunning ? (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 bg-success/10 text-success border-0">
                              <Zap className="h-3 w-3 mr-0.5" /> Auto
                            </Badge>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">Off</span>
                          )}
                          {/* Pre-generate draft button */}
                          {(() => {
                            const draftStatus = getStatus(lead.id);
                            return (
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className={cn(
                                        "h-5 w-5 p-0",
                                        draftStatus?.status === "ready" && "text-success"
                                      )}
                                      onClick={(e) => handlePreGenerate(lead, e)}
                                      disabled={draftStatus?.status === "generating"}
                                    >
                                      {draftStatus?.status === "generating" ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : draftStatus?.status === "ready" ? (
                                        <Check className="h-3 w-3" />
                                      ) : (
                                        <Wand2 className="h-3 w-3" />
                                      )}
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="text-xs">
                                    {draftStatus?.status === "generating" ? "Generating draft…" : draftStatus?.status === "ready" ? "Draft ready — click to open" : "Pre-generate draft"}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            );
                          })()}
                          {revenueStateFilter !== "action_required" && revenueStateFilter !== "heating_up" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 w-5 p-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenEmailDialog(lead, "");
                              }}
                              title="Compose email"
                            >
                              <Mail className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}

                    {/* Action button for action_required / heating_up */}
                    {revenueStateFilter === "action_required" && (
                      <TableCell className="py-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {/* Pre-generate icon */}
                          {(() => {
                            const draftStatus = getStatus(lead.id);
                            return (
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className={cn(
                                        "h-7 w-7 p-0",
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
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="text-xs">
                                    {draftStatus?.status === "generating" ? "Generating draft…" : draftStatus?.status === "ready" ? "Draft ready — click to open" : "Pre-generate draft"}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            );
                          })()}
                          {getActionButton(lead)}
                        </div>
                      </TableCell>
                    )}
                    {isHeatingUp && (
                      <TableCell className="py-2 text-right w-[80px] min-w-[80px]" onClick={(e) => e.stopPropagation()}>
                        {lead.next_action_key ? (
                          <Button
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handleOpenEmailDialog(lead, "")}
                          >
                            <Mail className="h-3 w-3 mr-1" />
                            Reply
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => handleOpenEmailDialog(lead, "")}
                            title="Compose email"
                          >
                            <Mail className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    )}

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
          prefilledSubject={(selectedLead as any)._prefilledSubject || undefined}
          prefilledBody={(selectedLead as any)._prefilledBody || undefined}
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

      <BulkAutomationDialog
        selectedLeads={leads.filter((l) => selectedLeads.has(l.id))}
        open={bulkAutomationOpen}
        onOpenChange={setBulkAutomationOpen}
        onSuccess={() => {
          setSelectedLeads(new Set());
          onLeadUpdated?.();
        }}
      />
    </>
  );
}
