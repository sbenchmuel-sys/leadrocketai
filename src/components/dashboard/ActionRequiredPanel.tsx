import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, Mail, FileText, Eye } from "lucide-react";
import { LeadWithContext } from "@/lib/dashboardUtils";

interface ActionRequiredPanelProps {
  leads: LeadWithContext[];
}

export function ActionRequiredPanel({ leads }: ActionRequiredPanelProps) {
  const actionLeads = leads.filter((l) => l.needsAction).slice(0, 5);

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

  const getActionButton = (lead: LeadWithContext) => {
    const basePath = `/dashboard/leads/${lead.id}`;

    switch (lead.actionType) {
      case "reply":
        return (
          <Button size="sm" asChild>
            <Link to={`${basePath}?tab=drafts`}>
              <Mail className="h-4 w-4 mr-1" />
              Reply
            </Link>
          </Button>
        );
      case "follow_up":
        return (
          <Button size="sm" asChild>
            <Link to={`${basePath}?tab=drafts`}>
              <FileText className="h-4 w-4 mr-1" />
              Draft
            </Link>
          </Button>
        );
      case "recap":
        return (
          <Button size="sm" asChild>
            <Link to={`${basePath}?tab=drafts`}>
              <FileText className="h-4 w-4 mr-1" />
              Recap
            </Link>
          </Button>
        );
      default:
        return (
          <Button size="sm" variant="outline" asChild>
            <Link to={basePath}>
              <Eye className="h-4 w-4 mr-1" />
              View
            </Link>
          </Button>
        );
    }
  };

  return (
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
              <p className="text-sm text-muted-foreground truncate">{lead.actionReason}</p>
            </div>
            <div className="ml-3 flex-shrink-0">{getActionButton(lead)}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
