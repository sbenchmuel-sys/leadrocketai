import { useEffect, useMemo, useState } from "react";
import { getLeadInteractions, InteractionItem } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { format, differenceInDays } from "date-fns";
import { Mail, MailOpen, Calendar, Phone, StickyNote, Settings2, ChevronDown, ChevronRight, MessageSquare, Plus } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface TimelineTabProps {
  leadId: string;
  onWhatsAppReply?: () => void;
}

/* ── Dedupe ── */
function dedupeTimelineItems(items: InteractionItem[]): InteractionItem[] {
  const byKey = new Map<string, InteractionItem>();
  for (const item of items) {
    const occurredMinute = Math.floor(new Date(item.occurred_at).getTime() / 60000);
    const stableKey = item.gmail_message_id
      ? `gmail:${item.gmail_message_id}`
      : `${item.source}|${item.type}|${(item.subject || "").toLowerCase()}|${(item.from_email || "").toLowerCase()}|${(item.to_email || "").toLowerCase()}|${occurredMinute}`;
    const existing = byKey.get(stableKey);
    if (!existing) { byKey.set(stableKey, item); continue; }
    if (!existing.gmail_message_id && item.gmail_message_id) byKey.set(stableKey, item);
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
  );
}

/* ── Thread grouping by normalized subject ── */
interface ThreadGroup {
  key: string;
  items: InteractionItem[];
  latest: InteractionItem;
}

function normalizeSubject(s: string | null): string {
  if (!s) return "";
  return s.replace(/^(re|fw|fwd):\s*/gi, "").trim().toLowerCase();
}

function groupIntoThreads(items: InteractionItem[]): (InteractionItem | ThreadGroup)[] {
  const emailItems = items.filter(i => i.type === "email_inbound" || i.type === "email_outbound");
  const nonEmailItems = items.filter(i => i.type !== "email_inbound" && i.type !== "email_outbound");

  const threadMap = new Map<string, InteractionItem[]>();
  for (const item of emailItems) {
    const key = normalizeSubject(item.subject) || item.id;
    const existing = threadMap.get(key);
    if (existing) existing.push(item);
    else threadMap.set(key, [item]);
  }

  const result: (InteractionItem | ThreadGroup)[] = [];

  // Merge emails and non-emails back in chronological order
  const threads: (InteractionItem | ThreadGroup)[] = [];
  for (const [key, threadItems] of threadMap) {
    if (threadItems.length === 1) {
      threads.push(threadItems[0]);
    } else {
      threadItems.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
      threads.push({ key, items: threadItems, latest: threadItems[0] });
    }
  }

  // Combine and sort by latest timestamp
  const all = [...threads, ...nonEmailItems];
  all.sort((a, b) => {
    const tsA = 'latest' in a ? new Date(a.latest.occurred_at).getTime() : new Date((a as InteractionItem).occurred_at).getTime();
    const tsB = 'latest' in b ? new Date(b.latest.occurred_at).getTime() : new Date((b as InteractionItem).occurred_at).getTime();
    return tsB - tsA;
  });

  return all;
}

function isThread(entry: InteractionItem | ThreadGroup): entry is ThreadGroup {
  return 'items' in entry;
}

/* ── Signal tags extraction ── */
function getSignalTags(item: InteractionItem): string[] {
  const tags: string[] = [];
  if (item.ai_intent) tags.push(item.ai_intent);
  const bodyLower = (item.body_text || "").toLowerCase();
  if (bodyLower.includes("pricing") || bodyLower.includes("price") || bodyLower.includes("cost")) tags.push("Pricing Mentioned");
  if (bodyLower.includes("decision") || bodyLower.includes("approve") || bodyLower.includes("sign off")) tags.push("Decision Maker Involved");
  if (bodyLower.includes("concern") || bodyLower.includes("issue") || bodyLower.includes("problem")) tags.push("Objection Raised");
  // Dedupe
  return [...new Set(tags)];
}

/* ── Auto-collapse: expand latest inbound, latest outbound, latest meeting, latest whatsapp ── */
function getAutoExpandIds(entries: (InteractionItem | ThreadGroup)[]): Set<string> {
  const ids = new Set<string>();
  let foundInbound = false, foundOutbound = false, foundMeeting = false, foundWhatsApp = false;

  for (const entry of entries) {
    if (isThread(entry)) {
      const latest = entry.latest;
      if (!foundInbound && latest.type === "email_inbound") { ids.add(entry.key); foundInbound = true; }
      if (!foundOutbound && latest.type === "email_outbound") { ids.add(entry.key); foundOutbound = true; }
    } else {
      if (!foundInbound && entry.type === "email_inbound") { ids.add(entry.id); foundInbound = true; }
      if (!foundOutbound && entry.type === "email_outbound") { ids.add(entry.id); foundOutbound = true; }
      if (!foundMeeting && entry.type === "meeting") { ids.add(entry.id); foundMeeting = true; }
      if (!foundWhatsApp && (entry.type === "whatsapp_inbound" || entry.type === "whatsapp_outbound")) { ids.add(entry.id); foundWhatsApp = true; }
    }
    if (foundInbound && foundOutbound && foundMeeting && foundWhatsApp) break;
  }
  return ids;
}

/* ── Channel badge ── */
function ChannelBadge({ type }: { type: string }) {
  const config: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
    email_inbound: { icon: <MailOpen className="h-3 w-3" />, label: "Inbound", className: "text-emerald-600 bg-emerald-500/10 border-emerald-500/20" },
    email_outbound: { icon: <Mail className="h-3 w-3" />, label: "Outbound", className: "text-blue-600 bg-blue-500/10 border-blue-500/20" },
    meeting: { icon: <Calendar className="h-3 w-3" />, label: "Meeting", className: "text-purple-600 bg-purple-500/10 border-purple-500/20" },
    call: { icon: <Phone className="h-3 w-3" />, label: "Call", className: "text-amber-600 bg-amber-500/10 border-amber-500/20" },
    whatsapp_outbound: { icon: <MessageSquare className="h-3 w-3" />, label: "WhatsApp", className: "text-green-600 bg-green-500/10 border-green-500/20" },
    whatsapp_inbound: { icon: <MessageSquare className="h-3 w-3" />, label: "WhatsApp", className: "text-green-600 bg-green-500/10 border-green-500/20" },
    note: { icon: <StickyNote className="h-3 w-3" />, label: "Note", className: "text-muted-foreground bg-muted border-border" },
  };
  const c = config[type] || config.note;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border", c.className)}>
      {c.icon}
      {c.label}
    </span>
  );
}

/* ── Single Entry Row ── */
function TimelineEntry({ item, defaultOpen }: { item: InteractionItem; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tags = useMemo(() => getSignalTags(item), [item]);
  const isMeeting = item.type === "meeting";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                {/* Meta line */}
                <div className="flex items-center gap-2 flex-wrap">
                  <ChannelBadge type={item.type} />
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(item.occurred_at), "MMM d · h:mm a")}
                  </span>
                  {item.ai_reply_worthy && (
                    <span className="text-[10px] font-medium text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                      Reply Needed
                    </span>
                  )}
                </div>
                {/* Subject */}
                {item.subject && (
                  <p className="text-sm font-medium text-foreground leading-snug truncate">
                    {item.subject}
                  </p>
                )}
                {/* Body preview (collapsed) */}
                {!open && item.body_text && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {item.body_text}
                  </p>
                )}
              </div>
              <div className="pt-1 text-muted-foreground/50">
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </div>
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="animate-accordion-down">
          <div className="pl-3 pb-2 space-y-2">
            {/* AI Summary */}
            {item.ai_summary && (
              <div className="bg-accent/50 rounded-md px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground mb-0.5">AI Summary</p>
                <p className="text-[13px] text-foreground leading-relaxed">{item.ai_summary}</p>
              </div>
            )}
            {/* Full body */}
            <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {item.body_text}
            </p>
            {/* Signal tags */}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {tags.map(tag => (
                  <span key={tag} className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/* ── Thread Group ── */
function ThreadEntry({ thread, defaultOpen }: { thread: ThreadGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const latest = thread.latest;
  const tags = useMemo(() => getSignalTags(latest), [latest]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <ChannelBadge type={latest.type} />
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(latest.occurred_at), "MMM d · h:mm a")}
                  </span>
                  <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full border border-border">
                    Thread ({thread.items.length})
                  </span>
                  {latest.ai_reply_worthy && (
                    <span className="text-[10px] font-medium text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                      Reply Needed
                    </span>
                  )}
                </div>
                {latest.subject && (
                  <p className="text-sm font-medium text-foreground leading-snug truncate">
                    {latest.subject}
                  </p>
                )}
                {!open && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {latest.body_text}
                  </p>
                )}
              </div>
              <div className="pt-1 text-muted-foreground/50">
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </div>
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="animate-accordion-down">
          <div className="pl-3 pb-2 space-y-2">
            {/* Latest message summary */}
            {latest.ai_summary && (
              <div className="bg-accent/50 rounded-md px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground mb-0.5">AI Summary</p>
                <p className="text-[13px] text-foreground leading-relaxed">{latest.ai_summary}</p>
              </div>
            )}
            <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed line-clamp-4">
              {latest.body_text}
            </p>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {tags.map(tag => (
                  <span key={tag} className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {/* Expand thread */}
            {thread.items.length > 1 && (
              <Collapsible open={threadExpanded} onOpenChange={setThreadExpanded}>
                <CollapsibleTrigger asChild>
                  <button className="text-[12px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 pt-1">
                    {threadExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    {threadExpanded ? "Collapse thread" : `Show ${thread.items.length - 1} earlier messages`}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="animate-accordion-down">
                  <div className="mt-2 ml-2 border-l-2 border-border pl-3 space-y-3">
                    {thread.items.slice(1).map(msg => (
                      <div key={msg.id} className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <ChannelBadge type={msg.type} />
                          <span className="text-[11px] text-muted-foreground">
                            {format(new Date(msg.occurred_at), "MMM d · h:mm a")}
                          </span>
                        </div>
                        <p className="text-[13px] text-muted-foreground line-clamp-3 leading-relaxed">
                          {msg.body_text}
                        </p>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/* ── Meeting Entry (Milestone Style) ── */
function MeetingEntry({ item, defaultOpen }: { item: InteractionItem; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <ChannelBadge type="meeting" />
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(item.occurred_at), "MMM d")}
                  </span>
                </div>
                {item.subject && (
                  <p className="text-sm font-medium text-foreground leading-snug">{item.subject}</p>
                )}
                {!open && item.ai_summary && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {item.ai_summary}
                  </p>
                )}
              </div>
              <div className="pt-1 text-muted-foreground/50">
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </div>
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="animate-accordion-down">
          <div className="pl-3 pb-2 space-y-2">
            {item.ai_summary && (
              <p className="text-[13px] text-foreground leading-relaxed">{item.ai_summary}</p>
            )}
            {item.body_text && (
              <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {item.body_text}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/* ── System Event (soft, centered) ── */
function SystemEvent({ text }: { text: string }) {
  return (
    <div className="py-4 flex items-center justify-center gap-2">
      <Settings2 className="h-3 w-3 text-muted-foreground/50" />
      <span className="text-[11px] text-muted-foreground/70">{text}</span>
    </div>
  );
}

/* ── WhatsApp Entry (chat-bubble style) ── */
function WhatsAppEntry({ item }: { item: InteractionItem }) {
  const isOutbound = item.type === "whatsapp_outbound";
  return (
    <div className={cn("py-3 px-3 -mx-3", isOutbound ? "flex justify-end" : "flex justify-start")}>
      <div className={cn(
        "max-w-[80%] rounded-2xl px-4 py-2.5 space-y-1",
        isOutbound
          ? "bg-primary/10 rounded-br-md"
          : "bg-accent rounded-bl-md"
      )}>
        <div className="flex items-center gap-2">
          <ChannelBadge type={item.type} />
          <span className="text-[11px] text-muted-foreground">
            {format(new Date(item.occurred_at), "MMM d · h:mm a")}
          </span>
        </div>
        <p className="text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">
          {item.body_text}
        </p>
      </div>
    </div>
  );
}

/* ── Main Component ── */
export default function TimelineTab({ leadId, onWhatsAppReply }: TimelineTabProps) {
  const [interactions, setInteractions] = useState<InteractionItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isSavingReply, setIsSavingReply] = useState(false);

  const loadInteractions = () => {
    getLeadInteractions(leadId)
      .then((items) => setInteractions(dedupeTimelineItems(items)))
      .catch(console.error)
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    loadInteractions();
  }, [leadId]);

  const handleLogWhatsAppReply = async () => {
    if (!replyText.trim()) return;
    setIsSavingReply(true);
    try {
      // 1. Create inbound WhatsApp interaction
      await supabase.from("interactions").insert({
        lead_id: leadId,
        type: "whatsapp_inbound",
        source: "manual",
        body_text: replyText.trim(),
        direction: "inbound",
        occurred_at: new Date().toISOString(),
      });

      // 2. Update lead: pause automation, set engaged, update last_inbound_at
      // Phase 6: WhatsApp inbound ALWAYS pauses automation — no exceptions
      await supabase.from("leads").update({
        last_inbound_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        stage: "engaged",
        motion: "engaged",
        needs_action: true,
        next_action_key: "reply_now",
        next_action_label: "Reply to WhatsApp message",
        nurture_status: "paused",
      }).eq("id", leadId);

      toast.success("WhatsApp reply logged — automation paused");
      setReplyText("");
      setShowReplyForm(false);
      loadInteractions();
      onWhatsAppReply?.();
    } catch (err) {
      console.error("[TimelineTab] WhatsApp reply log error:", err);
      toast.error("Failed to log reply");
    } finally {
      setIsSavingReply(false);
    }
  };

  const entries = useMemo(() => groupIntoThreads(interactions), [interactions]);
  const autoExpand = useMemo(() => getAutoExpandIds(entries), [entries]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground py-8">Loading interactions...</p>;
  }

  if (entries.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No interactions yet. Upload an email or meeting notes to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {/* Log WhatsApp Reply button */}
      <div className="flex justify-end pb-2">
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => setShowReplyForm(!showReplyForm)}
        >
          <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
          Log WhatsApp Reply
        </Button>
      </div>

      {/* Inline reply form */}
      {showReplyForm && (
        <div className="bg-accent/50 rounded-lg p-3 mb-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Paste or type the inbound WhatsApp message:</p>
          <Textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="e.g. Will review and revert by Monday..."
            rows={3}
            className="text-sm"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => { setShowReplyForm(false); setReplyText(""); }}>
              Cancel
            </Button>
            <Button size="sm" disabled={!replyText.trim() || isSavingReply} onClick={handleLogWhatsAppReply}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              {isSavingReply ? "Saving..." : "Log Reply"}
            </Button>
          </div>
        </div>
      )}

      {entries.map((entry, idx) => {
        const key = isThread(entry) ? entry.key : entry.id;
        const isExpanded = autoExpand.has(key);
        const isWhatsApp = !isThread(entry) && (entry.type === "whatsapp_inbound" || entry.type === "whatsapp_outbound");

        return (
          <div key={key}>
            {idx > 0 && <div className="border-t border-border/50 mx-0" />}
            {isThread(entry) ? (
              <ThreadEntry thread={entry} defaultOpen={isExpanded} />
            ) : entry.type === "meeting" ? (
              <MeetingEntry item={entry} defaultOpen={isExpanded} />
            ) : isWhatsApp ? (
              <WhatsAppEntry item={entry} />
            ) : (
              <TimelineEntry item={entry} defaultOpen={isExpanded} />
            )}
          </div>
        );
      })}
    </div>
  );
}