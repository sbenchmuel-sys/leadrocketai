import { useState } from "react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Mail, FileText, Eye, Plus, Send, Lightbulb, Sparkles } from "lucide-react";
import { EnrichedLead, STAGE_LABELS, DealStage, getActionType } from "@/lib/dashboardUtils";
import { EmailActionDialog } from "./EmailActionDialog";
import { formatDistanceToNow, isToday, isYesterday, differenceInHours } from "date-fns";

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
    ? "text-green-600 dark:text-green-400 font-medium" 
    : "text-muted-foreground";
  
  return { text, className };
}

interface LeadTableProps {
  leads: EnrichedLead[];
  isLoading: boolean;
  onLeadUpdated?: () => void;
}

const stageBadgeVariants: Record<DealStage, string> = {
  new: "bg-secondary text-secondary-foreground",
  contacted: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  engaged: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300",
  post_meeting: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
  closing: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300",
  closed_won: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  closed_lost: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
};

export function LeadTable({ leads, isLoading, onLeadUpdated }: LeadTableProps) {
  const [selectedLead, setSelectedLead] = useState<EnrichedLead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [currentInstructions, setCurrentInstructions] = useState("");
  const [instructionsPopover, setInstructionsPopover] = useState<string | null>(null);
  const [tempInstructions, setTempInstructions] = useState("");
  const navigate = useNavigate();

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

  const getActionButton = (lead: EnrichedLead) => {
    const basePath = `/dashboard/leads/${lead.id}`;
    const actionType = getActionType(lead.next_action_key);

    // Email compose button - always available
    const EmailComposeButton = () => (
      <Popover 
        open={instructionsPopover === `compose-${lead.id}`} 
        onOpenChange={(open) => !open && setInstructionsPopover(null)}
      >
        <PopoverTrigger asChild>
          <Button 
            size="sm" 
            variant="ghost" 
            onClick={(e) => {
              e.stopPropagation();
              setTempInstructions("");
              setInstructionsPopover(`compose-${lead.id}`);
            }}
          >
            <Mail className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-amber-500" />
              <span className="text-sm font-medium">Add instructions (optional)</span>
            </div>
            <Input
              value={tempInstructions}
              onChange={(e) => setTempInstructions(e.target.value)}
              placeholder="e.g., Follow up on pricing discussion..."
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
                Compose Email
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );

    // View button - always available
    const ViewButton = () => (
      <Button size="sm" variant="ghost" asChild>
        <Link to={basePath}>
          <Eye className="h-4 w-4" />
        </Link>
      </Button>
    );

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
                  <Lightbulb className="h-4 w-4 text-amber-500" />
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
          <EmailComposeButton />
          <ViewButton />
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
                  <Lightbulb className="h-4 w-4 text-amber-500" />
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
          <EmailComposeButton />
          <ViewButton />
        </div>
      );
    }

    // Default: just email compose + view
    return (
      <div className="flex items-center gap-1">
        <EmailComposeButton />
        <ViewButton />
      </div>
    );
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Leads</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead className="hidden md:table-cell">Last Email</TableHead>
                <TableHead className="hidden lg:table-cell">Next Action</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => {
                const lastEmail = formatLastEmail(lead.last_outbound_at);
                return (
                <TableRow
                  key={lead.id}
                  className="cursor-pointer"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button, a, [role='dialog']")) return;
                    navigate(`/dashboard/leads/${lead.id}`);
                  }}
                >
                  <TableCell>
                    <div>
                      <p className="font-medium text-foreground">{lead.name}</p>
                      <p className="text-sm text-muted-foreground">{lead.company}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={stageBadgeVariants[lead.stage]}>
                      {STAGE_LABELS[lead.stage]}
                    </Badge>
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
    </>
  );
}
