import { useState, useRef, useMemo, useEffect } from "react";
import { Send, X, Pencil, Check, Loader2, Sparkles, ThumbsUp, ThumbsDown } from "lucide-react";
import { captureStyleExample, type StyleChannel, type StyleMotion } from "@/lib/styleCapture";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import {
  providerToCanonical,
  canonicalLabel,
  canonicalIcon,
  getAvailableChannelsForLead,
  type CanonicalChannel,
  type AvailableChannel,
} from "@/lib/channels";
import { refreshDashboard } from "@/lib/dashboardMetricsService";

type PersonalizedSuggestion =
  | { subject: string; body: string }   // email
  | { text: string }                     // sms/whatsapp
  | { bullets: string[] };               // voice

type Props = {
  conversation: ConversationListItem;
  recommendedChannel: "whatsapp" | "email";
  suggestions: ReplySuggestion[];
  leadId?: string | null;
  onSent?: () => void;
};

export function ReplyComposer({ conversation, recommendedChannel, suggestions, leadId, onSent }: Props) {
  const { workspaceId } = useWorkspace();
  // Derive available channels — only email and whatsapp are implemented
  const [leadFields, setLeadFields] = useState<{
    email?: string | null;
    phone?: string | null;
    whatsapp_number?: string | null;
    wa_opted_in?: boolean;
    country?: string | null;
  } | null>(null);

  useEffect(() => {
    if (!leadId) {
      setLeadFields(null);
      return;
    }
    supabase
      .from("leads")
      .select("email, phone, whatsapp_number, wa_opted_in, country")
      .eq("id", leadId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setLeadFields(data);
      });
  }, [leadId]);

  const availableChannels = useMemo<AvailableChannel[]>(() => {
    const convoCanonical = providerToCanonical(conversation.channel);

    if (!leadFields) {
      const channels: AvailableChannel[] = [{ channel: convoCanonical }];
      if (convoCanonical !== "email") {
        channels.push({ channel: "email" });
      }
      return channels;
    }

    const available = getAvailableChannelsForLead({
      lead: leadFields,
      workspace: {
        whatsapp_enabled: true,
        voice_enabled: true,
      },
      lastInboundCanonical: convoCanonical,
    });

    // Only keep channels that have actual send implementations
    return available.filter((a) => a.channel === "email" || a.channel === "whatsapp");
  }, [leadFields, conversation.channel]);

  const defaultChannel = useMemo<CanonicalChannel>(() => {
    const rec = recommendedChannel as CanonicalChannel;
    if (availableChannels.some((a) => a.channel === rec)) return rec;
    return availableChannels[0]?.channel ?? "email";
  }, [recommendedChannel, availableChannels]);

  const [channel, setChannel] = useState<CanonicalChannel>(defaultChannel);
  const [body, setBody] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedSuggestions, setEditedSuggestions] = useState<Record<number, string>>({});
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Personalized suggestions state
  const [isPersonalizing, setIsPersonalizing] = useState(false);
  const [personalizedSuggestions, setPersonalizedSuggestions] = useState<PersonalizedSuggestion[]>([]);

  // Sync default channel when recommendation changes but preserve draft body
  useEffect(() => {
    setChannel(defaultChannel);
  }, [defaultChannel]);

  const handleSuggestionClick = (text: string) => {
    setBody(text);
  };

  // ── Personalize handler ──
  const handlePersonalize = async () => {
    if (!leadId) {
      toast({ title: "No lead linked", description: "Cannot personalize without a lead.", variant: "destructive" });
      return;
    }
    setIsPersonalizing(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        toast({ title: "Not logged in", variant: "destructive" });
        return;
      }

      const res = await fetch(`${supabaseUrl}/functions/v1/generate-personalized-suggestions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          lead_id: leadId,
          channel,
          user_draft: body.trim() || undefined,
        }),
      });

      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }

      const data = await res.json();
      const sug = data.suggestions ?? [];
      if (sug.length === 0) {
        toast({ title: "No suggestions", description: "AI couldn't generate suggestions for this lead." });
      }
      setPersonalizedSuggestions(sug);
    } catch (err: any) {
      console.error("[ReplyComposer] Personalize error:", err);
      toast({ title: "Personalization failed", description: err.message || "Could not generate suggestions.", variant: "destructive" });
    } finally {
      setIsPersonalizing(false);
    }
  };

  const applyPersonalizedSuggestion = (s: PersonalizedSuggestion) => {
    if ("body" in s) {
      setBody(s.body);
    } else if ("text" in s) {
      setBody(s.text);
    } else if ("bullets" in s) {
      setBody(s.bullets.map((b) => `• ${b}`).join("\n"));
    }
  };

  const getPersonalizedLabel = (s: PersonalizedSuggestion, i: number) => {
    const tones = ["⚡ Direct", "🤝 Consultative", "💪 Assertive"];
    if ("subject" in s) return `${tones[i] ?? tones[0]}: ${s.subject.slice(0, 30)}…`;
    if ("text" in s) return `${tones[i] ?? tones[0]}: ${s.text.slice(0, 30)}…`;
    return tones[i] ?? `Option ${i + 1}`;
  };

  const handleSend = async () => {
    if (!body.trim()) return;
    setIsSending(true);

    try {
      if (channel === "whatsapp") {
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
      } else if (channel === "email") {
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

        const { data: convData } = await supabase
          .from("conversations")
          .select("provider_thread_id")
          .eq("id", conversation.id)
          .single();

        const sendBody: Record<string, any> = {
          to: emailIdentity.value,
          subject: `Re: ${conversation.contact_name}`,
          body: body.trim(),
          threadId: convData?.provider_thread_id || undefined,
        };
        if (leadId) sendBody.leadId = leadId;

        const { data: sendResult, error: sendErr } = await supabase.functions.invoke("gmail-send", {
          body: sendBody,
        });

        if (sendErr) throw sendErr;
        if (sendResult?.error) throw new Error(sendResult.error);
        if (sendResult?.needsReconnect) {
          throw new Error("Gmail needs reconnection. Please reauthorize in Settings.");
        }

        toast({ title: "Email sent", description: "Email delivered successfully." });
      } else {
        // Unreachable since we filter to email/whatsapp only, but defensive
        toast({ title: "Not yet supported", description: `${canonicalLabel(channel)} sending is coming soon.` });
        return;
      }

      // Clear after successful send
      const sentBody = body.trim();
      setBody("");
      setPersonalizedSuggestions([]);

      // Capture style example (non-blocking)
      if (workspaceId && sentBody) {
        const ch = channel as string;
        const styleChannel: StyleChannel = ch === "whatsapp" ? "whatsapp" : ch === "sms" ? "sms" : "email";
        const styleMotion: StyleMotion = "reply_to_thread";
        captureStyleExample({
          channel: styleChannel,
          motionType: styleMotion,
          bodyText: sentBody,
          subject: ch === "email" ? `Re: ${conversation.contact_name}` : undefined,
          workspaceId,
        }).catch(() => {});
      }

      // Best-effort post-send hooks
      try { onSent?.(); } catch (_) { /* non-blocking */ }
      try { refreshDashboard("email_sent"); } catch (_) { /* non-blocking */ }
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
                    <ThumbsUp
                      className="h-3 w-3 opacity-40 hover:opacity-100 hover:text-emerald-600 dark:hover:text-emerald-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (workspaceId) {
                          captureStyleExample({
                            channel: (channel as string) === "whatsapp" ? "whatsapp" : (channel as string) === "sms" ? "sms" : "email",
                            motionType: "reply_to_thread",
                            bodyText: displayText,
                            feedback: "liked",
                            workspaceId,
                          }).catch(() => {});
                          toast({ title: "👍 Style noted", description: "We'll learn from this." });
                        }
                      }}
                    />
                    <ThumbsDown
                      className="h-3 w-3 opacity-40 hover:opacity-100 hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        const comment = prompt("What didn't you like? (optional)");
                        if (workspaceId) {
                          captureStyleExample({
                            channel: (channel as string) === "whatsapp" ? "whatsapp" : (channel as string) === "sms" ? "sms" : "email",
                            motionType: "reply_to_thread",
                            bodyText: displayText,
                            feedback: "disliked",
                            feedbackComment: comment || undefined,
                            workspaceId,
                          }).catch(() => {});
                          toast({ title: "👎 Anti-pattern noted", description: "We'll avoid this style." });
                        }
                      }}
                    />
                    <Pencil
                      className="h-3 w-3 opacity-50 hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingIndex(isEditing ? null : i);
                        if (!isEditing) {
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

      {/* Personalized suggestion chips */}
      {personalizedSuggestions.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {personalizedSuggestions.map((s, i) => (
            <button
              key={`p-${i}`}
              onClick={() => applyPersonalizedSuggestion(s)}
              className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 transition-colors text-foreground hover:bg-primary/10"
            >
              {getPersonalizedLabel(s, i)}
            </button>
          ))}
        </div>
      )}

      {/* Composer row */}
      <div className="flex items-end gap-2">
        {/* Channel selector — only implemented channels */}
        <Select value={channel} onValueChange={(v) => setChannel(v as CanonicalChannel)}>
          <SelectTrigger className="w-[120px] h-9 text-xs shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableChannels.map((ac) => {
              const Icon = canonicalIcon(ac.channel);
              return (
                <SelectItem key={ac.channel} value={ac.channel}>
                  <span className="flex items-center gap-1.5">
                    <Icon className="h-3 w-3" /> {canonicalLabel(ac.channel)}
                  </span>
                </SelectItem>
              );
            })}
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

        {/* Personalize button */}
        {leadId && (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={handlePersonalize}
            disabled={isPersonalizing}
            title="Personalize with AI"
          >
            {isPersonalizing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </Button>
        )}

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
      {channel !== (recommendedChannel as CanonicalChannel) && (
        <p className="text-[10px] text-muted-foreground">
          💡 AI recommends <span className="font-medium capitalize">{canonicalLabel(recommendedChannel as CanonicalChannel)}</span> for this contact
        </p>
      )}
    </div>
  );
}
