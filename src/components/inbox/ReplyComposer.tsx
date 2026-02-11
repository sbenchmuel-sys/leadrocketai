import { useState, useRef } from "react";
import { Send, Paperclip, MessageSquare, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import type { ConversationListItem, ReplySuggestion } from "@/lib/inboxQueries";

type Props = {
  conversation: ConversationListItem;
  recommendedChannel: "whatsapp" | "email";
  suggestions: ReplySuggestion[];
};

export function ReplyComposer({ conversation, recommendedChannel, suggestions }: Props) {
  const [channel, setChannel] = useState<"whatsapp" | "email">(recommendedChannel);
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSuggestionClick = (text: string) => {
    setBody(text);
  };

  const handleAttach = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const valid = files.filter((f) => {
      const isValid = f.type.startsWith("image/") || f.type === "application/pdf";
      const sizeOk = f.size <= 10 * 1024 * 1024; // 10MB
      return isValid && sizeOk;
    });
    setAttachments((prev) => [...prev, ...valid]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    if (!body.trim()) return;
    setIsSending(true);

    // Phase 1: Manual send only — just show confirmation
    // In production, this would call whatsapp-send or gmail-send edge functions
    toast({
      title: "Ready to send",
      description: `Message prepared for ${channel}. Sending integration coming in Phase 2.`,
    });

    setIsSending(false);
  };

  return (
    <div className="shrink-0 border-t border-border p-3 space-y-2">
      {/* Suggestion chips */}
      {suggestions.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => handleSuggestionClick(s.text)}
              className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              {s.style === "professional" ? "💼" : s.style === "consultative" ? "🤝" : "⚡"}{" "}
              {s.style}
            </button>
          ))}
        </div>
      )}

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {attachments.map((file, i) => (
            <Badge key={i} variant="secondary" className="text-xs gap-1 pr-1">
              📎 {file.name.slice(0, 20)}
              <button onClick={() => removeAttachment(i)} className="ml-1 hover:text-destructive">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Composer row */}
      <div className="flex items-end gap-2">
        {/* Channel selector */}
        <Select value={channel} onValueChange={(v) => setChannel(v as "whatsapp" | "email")}>
          <SelectTrigger className="w-[110px] h-9 text-xs shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="whatsapp">
              <span className="flex items-center gap-1.5">
                <MessageSquare className="h-3 w-3" /> WhatsApp
              </span>
            </SelectItem>
            <SelectItem value="email">
              <span className="flex items-center gap-1.5">
                <Mail className="h-3 w-3" /> Email
              </span>
            </SelectItem>
          </SelectContent>
        </Select>

        {/* Text input */}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Type a message..."
          className="min-h-[36px] max-h-32 resize-none text-sm flex-1"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />

        {/* Attachment */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={handleAttach}>
          <Paperclip className="h-4 w-4" />
        </Button>

        {/* Send */}
        <Button
          size="icon"
          className="h-9 w-9 shrink-0"
          disabled={!body.trim() || isSending}
          onClick={handleSend}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>

      {/* Channel recommendation hint */}
      {channel !== recommendedChannel && (
        <p className="text-[10px] text-muted-foreground">
          💡 AI recommends <span className="font-medium capitalize">{recommendedChannel}</span> for this contact
        </p>
      )}
    </div>
  );
}
