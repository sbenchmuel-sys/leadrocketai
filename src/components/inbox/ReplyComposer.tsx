import { useState, useRef } from "react";
import { Send, Paperclip, MessageSquare, Mail, X, Pencil, Check, Loader2 } from "lucide-react";
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
import { supabase } from "@/integrations/supabase/client";
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
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedSuggestions, setEditedSuggestions] = useState<Record<number, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

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

    try {
      if (channel === "whatsapp") {
        // Look up the contact's phone identity
        const { data: identity, error: idErr } = await supabase
          .from("contact_identities")
          .select("value")
          .eq("contact_id", conversation.contact_id)
          .in("type", ["phone", "whatsapp"])
          .limit(1)
          .maybeSingle();

        if (idErr || !identity?.value) {
          throw new Error("No phone number found for this contact.");
        }

        const { data, error } = await supabase.functions.invoke("whatsapp-send", {
          body: {
            conversation_id: conversation.id,
            to: identity.value,
            message_text: body.trim(),
          },
        });

        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        toast({ title: "Message sent", description: "WhatsApp message delivered." });
        try { setBody(""); setAttachments([]); } catch (_) { /* non-blocking cleanup */ }
      } else {
        // Resolve the contact's email identity first
        const { data: emailIdentity, error: emailIdErr } = await supabase
          .from("contact_identities")
          .select("value")
          .eq("contact_id", conversation.contact_id)
          .eq("type", "email")
          .limit(1)
          .maybeSingle();

        if (emailIdErr || !emailIdentity?.value) {
          throw new Error("No email address found for this contact.");
        }

        // Get the conversation's thread info for proper threading
        const { data: convData } = await supabase
          .from("conversations")
          .select("provider_thread_id")
          .eq("id", conversation.id)
          .single();

        const { data: sendResult, error: sendErr } = await supabase.functions.invoke("gmail-send", {
          body: {
            to: emailIdentity.value,
            subject: `Re: ${conversation.contact_name}`,
            body: body.trim(),
            threadId: convData?.provider_thread_id || undefined,
          },
        });

        if (sendErr) throw sendErr;
        if (sendResult?.error) throw new Error(sendResult.error);
        if (sendResult?.needsReconnect) {
          throw new Error("Gmail needs reconnection. Please reauthorize in Settings.");
        }

        toast({ title: "Email sent", description: "Email delivered successfully." });
        try { setBody(""); setAttachments([]); } catch (_) { /* non-blocking cleanup */ }
      }
    } catch (err: any) {
      console.error("[ReplyComposer] Send error:", err);
      toast({
        title: "Send failed",
        description: err.message || "Could not send message.",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-border p-3 space-y-2">
      {/* Suggestion chips */}
      {suggestions.length > 0 && (
        <div className="space-y-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {suggestions.map((s, i) => {
              const isEditing = editingIndex === i;
              const displayText = editedSuggestions[i] ?? s.text;
              const icon = s.style === "direct" ? "⚡" : s.style === "consultative" ? "🤝" : "💪";
              const label = s.style === "direct" ? "Direct" : s.style === "consultative" ? "Consultative" : "Assertive";

              return (
                <button
                  key={i}
                  onClick={() => {
                    if (!isEditing) handleSuggestionClick(displayText);
                  }}
                  className={cn(
                    "shrink-0 text-xs px-3 py-1.5 rounded-full border border-border transition-colors text-muted-foreground",
                    isEditing
                      ? "bg-accent/50 text-foreground ring-1 ring-primary/30"
                      : "hover:bg-accent hover:text-foreground"
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    {icon} {label}
                    <Pencil
                      className="h-3 w-3 opacity-50 hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingIndex(isEditing ? null : i);
                        if (!isEditing) {
                          // Initialize edit text if not already edited
                          setEditedSuggestions((prev) => ({
                            ...prev,
                            [i]: prev[i] ?? s.text,
                          }));
                          setTimeout(() => editRef.current?.focus(), 50);
                        }
                      }}
                    />
                  </span>
                </button>
              );
            })}
          </div>

          {/* Inline editor */}
          {editingIndex !== null && (
            <div className="rounded-md border border-border bg-muted/30 p-2 space-y-2">
              <Textarea
                ref={editRef}
                value={editedSuggestions[editingIndex] ?? suggestions[editingIndex]?.text ?? ""}
                onChange={(e) =>
                  setEditedSuggestions((prev) => ({ ...prev, [editingIndex]: e.target.value }))
                }
                className="text-sm min-h-[60px] max-h-48 resize-none bg-background"
                rows={3}
              />
              <div className="flex gap-2 justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setEditingIndex(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => {
                    const text = editedSuggestions[editingIndex];
                    if (text?.trim()) {
                      setBody(text);
                      setEditingIndex(null);
                    }
                  }}
                >
                  <Check className="h-3 w-3" /> Use this draft
                </Button>
              </div>
            </div>
          )}
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
          {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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
