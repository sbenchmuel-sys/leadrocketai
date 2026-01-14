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
import { Mail, FileText, Eye, Plus, Send } from "lucide-react";
import { EnrichedLead, STAGE_LABELS, DealStage, getActionType } from "@/lib/dashboardUtils";
import { EmailActionDialog } from "./EmailActionDialog";

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

  const handleOpenEmailDialog = (lead: EnrichedLead, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedLead(lead);
    setDialogOpen(true);
  };

  const getActionButton = (lead: EnrichedLead) => {
    const basePath = `/dashboard/leads/${lead.id}`;
    const actionType = getActionType(lead.next_action_key);

    if (lead.needs_action) {
      switch (actionType) {
        case "reply":
          return (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="default" onClick={(e) => handleOpenEmailDialog(lead, e)}>
                <Mail className="h-4 w-4 mr-1" />
                Reply
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link to={basePath}>
                  <Eye className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          );
        case "follow_up":
        case "recap":
          return (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="default" onClick={(e) => handleOpenEmailDialog(lead, e)}>
                <FileText className="h-4 w-4 mr-1" />
                Draft
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link to={basePath}>
                  <Eye className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          );
        case "nurture":
          return (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="default" onClick={(e) => handleOpenEmailDialog(lead, e)}>
                <Send className="h-4 w-4 mr-1" />
                Send
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link to={basePath}>
                  <Eye className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          );
      }
    }

    return (
      <Button size="sm" variant="ghost" asChild>
        <Link to={basePath}>
          <Eye className="h-4 w-4 mr-1" />
          View
        </Link>
      </Button>
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
                <TableHead className="hidden md:table-cell">Next Action</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <TableRow
                  key={lead.id}
                  className="cursor-pointer"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button, a")) return;
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
                    <p className="text-sm text-muted-foreground truncate max-w-[200px]">
                      {lead.next_action_label || "—"}
                    </p>
                  </TableCell>
                  <TableCell className="text-right">{getActionButton(lead)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
