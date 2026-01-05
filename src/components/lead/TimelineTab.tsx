import { useEffect, useState } from "react";
import { getLeadInteractions, InteractionItem } from "@/lib/supabaseQueries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { Mail, MailOpen, Calendar, Phone, StickyNote } from "lucide-react";

interface TimelineTabProps {
  leadId: string;
}

export default function TimelineTab({ leadId }: TimelineTabProps) {
  const [interactions, setInteractions] = useState<InteractionItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getLeadInteractions(leadId)
      .then(setInteractions)
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [leadId]);

  const getIcon = (type: string) => {
    switch (type) {
      case "email_inbound":
        return <MailOpen className="h-4 w-4" />;
      case "email_outbound":
        return <Mail className="h-4 w-4" />;
      case "meeting":
        return <Calendar className="h-4 w-4" />;
      case "call":
        return <Phone className="h-4 w-4" />;
      default:
        return <StickyNote className="h-4 w-4" />;
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case "email_inbound":
        return "Inbound Email";
      case "email_outbound":
        return "Outbound Email";
      case "meeting":
        return "Meeting";
      case "call":
        return "Call";
      case "note":
        return "Note";
      default:
        return type;
    }
  };

  if (isLoading) {
    return <p className="text-muted-foreground">Loading interactions...</p>;
  }

  if (interactions.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">
            No interactions yet. Upload an email or meeting notes to get started.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {interactions.map((interaction) => (
        <Card key={interaction.id}>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {getIcon(interaction.type)}
              <span>{getTypeLabel(interaction.type)}</span>
              <span>•</span>
              <span>{format(new Date(interaction.occurred_at), "MMM d, yyyy h:mm a")}</span>
              {interaction.ai_reply_worthy && (
                <Badge variant="destructive" className="ml-auto">
                  Reply Needed
                </Badge>
              )}
            </div>
            {interaction.subject && (
              <CardTitle className="text-base">{interaction.subject}</CardTitle>
            )}
          </CardHeader>
          <CardContent>
            {interaction.ai_summary && (
              <div className="mb-3 p-3 bg-accent rounded-md">
                <p className="text-xs font-medium text-muted-foreground mb-1">AI Summary</p>
                <p className="text-sm">{interaction.ai_summary}</p>
                {interaction.ai_intent && (
                  <Badge variant="outline" className="mt-2">
                    {interaction.ai_intent}
                  </Badge>
                )}
              </div>
            )}
            <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-6">
              {interaction.body_text}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
