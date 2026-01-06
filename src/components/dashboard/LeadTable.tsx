import { Link } from "react-router-dom";
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
import { Mail, FileText, Eye, Plus } from "lucide-react";
import { LeadWithContext, STAGE_LABELS, DealStage } from "@/lib/dashboardUtils";

interface LeadTableProps {
  leads: LeadWithContext[];
  isLoading: boolean;
}

const stageBadgeVariants: Record<DealStage, string> = {
  new: "bg-secondary text-secondary-foreground",
  contacted: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  engaged: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300",
  post_meeting: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
  closing: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300",
};

export function LeadTable({ leads, isLoading }: LeadTableProps) {
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

  const getActionButton = (lead: LeadWithContext) => {
    const basePath = `/dashboard/leads/${lead.id}`;

    if (lead.needsAction) {
      switch (lead.actionType) {
        case "reply":
          return (
            <Button size="sm" variant="default" asChild>
              <Link to={`${basePath}?tab=drafts`}>
                <Mail className="h-4 w-4 mr-1" />
                Reply
              </Link>
            </Button>
          );
        case "follow_up":
        case "recap":
          return (
            <Button size="sm" variant="default" asChild>
              <Link to={`${basePath}?tab=drafts`}>
                <FileText className="h-4 w-4 mr-1" />
                Draft
              </Link>
            </Button>
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
                  // Don't navigate if clicking a button
                  if ((e.target as HTMLElement).closest("button, a")) return;
                  window.location.href = `/dashboard/leads/${lead.id}`;
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
                    {lead.actionReason || "—"}
                  </p>
                </TableCell>
                <TableCell className="text-right">{getActionButton(lead)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
