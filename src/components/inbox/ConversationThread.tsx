import { useEffect, useState, useRef } from "react";
import { format } from "date-fns";
import { ArrowLeft, MessageSquare, Mail, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  fetchDecryptedMessages,
  fetchContactAnalysis,
  type ConversationListItem,
  type DecryptedMessage,
  type ConversationAnalysis,
} from "@/lib/inboxQueries";

type Props = {
  conversation: ConversationListItem;
  onBack: () => void;
  onAnalysisLoaded: (a: ConversationAnalysis | null) => void;
};

export function ConversationThread({ conversation, onBack, onAnalysisLoaded }: Props) {
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    Promise.all([
      fetchDecryptedMessages(conversation.id),
      fetchContactAnalysis(conversation.contact_id),
    ])
      .then(([msgData, contactAnalysis]) => {
        if (cancelled) return;
        setMessages(msgData.messages);
        // Prefer contact-level rollup, fall back to conversation analysis
        onAnalysisLoaded(contactAnalysis ?? msgData.analysis);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [conversation.id, conversation.contact_id, onAnalysisLoaded]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Thread header */}
      <div className="shrink-0 px-4 py-3 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon" className="md:hidden h-8 w-8" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className={cn(
          "rounded-full p-1.5 shrink-0",
          conversation.channel === "whatsapp"
            ? "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]"
            : "bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))]"
        )}>
          {conversation.channel === "whatsapp" ? (
            <MessageSquare className="h-4 w-4" />
          ) : (
            <Mail className="h-4 w-4" />
          )}
        </div>

        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">
            {conversation.contact_name}
          </h3>
          {conversation.contact_company && (
            <span className="text-xs text-muted-foreground">{conversation.contact_company}</span>
          )}
        </div>

        <Badge variant="outline" className="ml-auto text-xs capitalize">
          {conversation.contact_status}
        </Badge>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse">
                <div className={`h-16 bg-muted rounded-lg w-3/4 ${i % 2 === 0 ? "ml-auto" : ""}`} />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8">No messages</div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: DecryptedMessage }) {
  const isOutbound = message.direction === "outbound";

  return (
    <div className={cn("flex", isOutbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm",
          isOutbound
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-muted text-foreground rounded-bl-md"
        )}
      >
        {message.is_expired && !message.body_text ? (
          <div className="flex items-center gap-1.5 text-muted-foreground italic text-xs">
            <Clock className="h-3 w-3" />
            <span>Message expired — see AI summary</span>
          </div>
        ) : message.body_text ? (
          <p className="whitespace-pre-wrap break-words">{message.body_text}</p>
        ) : (
          <span className="text-muted-foreground italic text-xs">No content</span>
        )}

        {message.media_type && message.media_type !== "text" && (
          <Badge variant="secondary" className="mt-1 text-[10px]">
            📎 {message.media_type}
          </Badge>
        )}

        <div className={cn(
          "text-[10px] mt-1",
          isOutbound ? "text-primary-foreground/60" : "text-muted-foreground"
        )}>
          {format(new Date(message.created_at), "MMM d, h:mm a")}
        </div>
      </div>
    </div>
  );
}
