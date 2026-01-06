import { useEffect, useMemo, useState } from "react";
import { getLeadInteractions, InteractionItem } from "@/lib/supabaseQueries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { Mail, MailOpen, Calendar, Phone, StickyNote } from "lucide-react";

interface TimelineTabProps {
  leadId: string;
}

function dedupeTimelineItems(items: InteractionItem[]): InteractionItem[] {
  const byKey = new Map<string, InteractionItem>();

  for (const item of items) {
    const occurredTs = new Date(item.occurred_at).getTime();
    const occurredMinute = Math.floor(occurredTs / 60000); // minute bucket

    const stableKey = item.gmail_message_id
      ? `gmail:${item.gmail_message_id}`
      : `${item.source}|${item.type}|${(item.subject || "").toLowerCase()}|${(item.from_email || "").toLowerCase()}|${(item.to_email || "").toLowerCase()}|${occurredMinute}`;

    const existing = byKey.get(stableKey);
    if (!existing) {
      byKey.set(stableKey, item);
      continue;
    }

    // Prefer the record that has a gmail_message_id (it dedupes correctly across syncs)
    const existingHasId = !!existing.gmail_message_id;
    const nextHasId = !!item.gmail_message_id;
    if (!existingHasId && nextHasId) {
      byKey.set(stableKey, item);
    }
  }

  return Array.from(byKey.values()).sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
  );
}

export default function TimelineTab({ leadId }: TimelineTabProps) {
  const [interactions, setInteractions] = useState<InteractionItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getLeadInteractions(leadId)
      .then((items) => setInteractions(dedupeTimelineItems(items)))
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
