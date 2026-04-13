import { useEffect, useState, useRef, useCallback } from "react";
import { format } from "date-fns";
import { ArrowLeft, Clock, Check, CheckCheck, RefreshCw, Phone, Mail, MessageSquare } from "lucide-react";
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
import { providerToCanonical, canonicalIcon, canonicalLabel, channelColors } from "@/lib/channels";

type Props = {
  conversation: ConversationListItem;
  onBack: () => void;
  onAnalysisLoaded: (a: ConversationAnalysis | null) => void;
  reloadKey?: number;
};

export function ConversationThread({ conversation, onBack, onAnalysisLoaded, reloadKey = 0 }: Props) {
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadMessages = useCallback(async (showFullLoader: boolean) => {
    if (showFullLoader) setIsLoading(true);
    else setIsRefreshing(true);
    try {
      // Use lead_id to fetch all cross-channel messages
      const leadId = conversation.lead_id ?? conversation.id;
      const [msgData, contactAnalysis] = await Promise.all([
        fetchDecryptedMessages(leadId),
        fetchContactAnalysis(leadId),
      ]);
      setMessages(msgData.messages);
      onAnalysisLoaded(contactAnalysis ?? msgData.analysis);
    } catch (err) {
      console.error("[ConversationThread] Load error:", err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [conversation.id, conversation.lead_id, onAnalysisLoaded]);

  useEffect(() => {
    loadMessages(true);
  }, [loadMessages]);

  useEffect(() => {
    if (reloadKey > 0) {
      loadMessages(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Channel badges for the header
  const channelsUsed = conversation.channels_used ?? [];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Thread header */}
      <div className="shrink-0 px-4 py-3 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon" className="md:hidden h-8 w-8" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground truncate">
            {conversation.contact_name}
          </h3>
          {conversation.contact_company && (
            <span className="text-xs text-muted-foreground">{conversation.contact_company}</span>
          )}
        </div>

        {/* Channel badges */}
        <div className="flex items-center gap-1">
          {channelsUsed.map((ch) => {
            const Icon = canonicalIcon(ch as any);
            const colors = channelColors(ch as any);
            return (
              <div
                key={ch}
                className="rounded-full p-1 shrink-0"
                style={{ backgroundColor: colors.bg, color: colors.fg }}
                title={canonicalLabel(ch as any)}
              >
                <Icon className="h-3 w-3" />
              </div>
            );
          })}
        </div>

        <Badge variant="outline" className="text-xs capitalize">
          {conversation.contact_status}
        </Badge>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => loadMessages(false)}
          disabled={isRefreshing}
          title="Refresh messages"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
        </Button>
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
          <div className="text-sm text-muted-foreground text-center py-8">No messages yet</div>
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
  const isVoice = message.media_type === "voice";

  return (
    <div className={cn("flex", isOutbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm",
          isVoice
            ? "bg-muted/50 text-foreground border border-border rounded-lg"
            : isOutbound
              ? "bg-primary text-primary-foreground rounded-br-md"
              : "bg-muted text-foreground rounded-bl-md"
        )}
      >
        {isVoice && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <Phone className="h-3 w-3" />
            <span>Phone call</span>
          </div>
        )}

        {message.body_text ? (
          <p className="whitespace-pre-wrap break-words">{message.body_text}</p>
        ) : (
          <span className="text-muted-foreground italic text-xs">No content</span>
        )}

        <div className={cn(
          "flex items-center gap-1 text-[10px] mt-1",
          isOutbound && !isVoice ? "justify-end text-primary-foreground/60" : "text-muted-foreground"
        )}>
          <span>{format(new Date(message.created_at), "MMM d, h:mm a")}</span>
        </div>
      </div>
    </div>
  );
}
