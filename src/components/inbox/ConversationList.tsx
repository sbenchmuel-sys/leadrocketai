import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fetchConversations, type ConversationListItem } from "@/lib/inboxQueries";
import { providerToCanonical, canonicalIcon, canonicalLabel, channelColors } from "@/lib/channels";

type Props = {
  filter: "active" | "new" | "archived";
  selectedId: string | null;
  onSelect: (convo: ConversationListItem) => void;
};

export function ConversationList({ filter, selectedId, onSelect }: Props) {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetchConversations(filter)
      .then((data) => {
        if (!cancelled) setConversations(data);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [filter]);

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="animate-pulse space-y-2">
            <div className="h-4 bg-muted rounded w-3/4" />
            <div className="h-3 bg-muted rounded w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (!conversations.length) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        No conversations
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {conversations.map((convo) => (
        <button
          key={convo.id}
          onClick={() => onSelect(convo)}
          className={cn(
            "w-full text-left px-4 py-3 hover:bg-accent/50 transition-colors",
            selectedId === convo.id && "bg-accent"
          )}
        >
          <div className="flex items-start gap-3">
            {/* Channel icon */}
            {(() => {
              const canonical = providerToCanonical(convo.channel);
              const Icon = canonicalIcon(canonical);
              const colors = channelColors(canonical);
              return (
                <div
                  className="mt-0.5 rounded-full p-1.5 shrink-0"
                  style={{ backgroundColor: colors.bg, color: colors.fg }}
                  title={canonicalLabel(canonical)}
                >
                  <Icon className="h-3.5 w-3.5" />
                </div>
              );
            })()}

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium truncate text-foreground">
                  {convo.contact_name}
                </span>
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                  {convo.last_message_at
                    ? formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: false })
                    : ""}
                </span>
              </div>

              {convo.contact_company && (
                <span className="text-xs text-muted-foreground truncate block">
                  {convo.contact_company}
                </span>
              )}

              {convo.latest_summary && (
                <p className="text-xs text-muted-foreground/70 truncate mt-0.5">
                  {convo.latest_summary}
                </p>
              )}

              <div className="flex items-center gap-1.5 mt-1">
                {convo.latest_sentiment && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                    {convo.latest_sentiment}
                  </Badge>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {convo.message_count} msg{convo.message_count !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
