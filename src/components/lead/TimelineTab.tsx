import { useEffect, useMemo, useState } from "react";
import { getLeadInteractions, hideInteraction, unhideInteraction, InteractionItem } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { format, differenceInDays } from "date-fns";
import { Mail, MailOpen, Calendar, Phone, StickyNote, Settings2, ChevronDown, ChevronRight, MessageSquare, Plus, EyeOff, Eye, Undo2, Zap } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface TimelineTabProps {
  leadId: string;
  onWhatsAppReply?: () => void;
}

/* ── Filter types ── */
type TimelineFilter = "all" | "emails" | "whatsapp" | "meetings" | "notes" | "automation";

const FILTER_OPTIONS: { value: TimelineFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "emails", label: "Emails" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "meetings", label: "Meetings" },
  { value: "notes", label: "Notes" },
  { value: "automation", label: "Automation" },
];

function matchesFilter(type: string, source: string, filter: TimelineFilter): boolean {
  if (filter === "all") return true;
  if (filter === "emails") return type === "email_inbound" || type === "email_outbound";
  if (filter === "whatsapp") return type === "whatsapp_inbound" || type === "whatsapp_outbound";
  if (filter === "meetings") return type === "meeting";
  if (filter === "notes") return type === "note" || type === "system_note";
  if (filter === "automation") return source === "automation";
  return true;
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

  const threads: (InteractionItem | ThreadGroup)[] = [];
  for (const [key, threadItems] of threadMap) {
    if (threadItems.length === 1) {
      threads.push(threadItems[0]);
    } else {
      threadItems.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
      threads.push({ key, items: threadItems, latest: threadItems[0] });
    }
  }

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
  return [...new Set(tags)];
}

/* ── Auto-collapse ── */
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

/* ── WA delivery status badge for timeline ── */
function WaDeliveryBadge({ bodyText }: { bodyText: string }) {
  // Parse status hint from body_text set by outbound send logic: "[status:read]" etc.
  // This is a lightweight approach — the interactions table doesn't store raw status,
  // so we embed a hint in ai_summary or check the source field for quick display.
  // For now, render nothing — status is shown live in the Inbox ConversationThread.
  return null;
}

/* ── Hide button ── */
function HideButton({ interactionId, isHidden, onToggle }: { interactionId: string; isHidden: boolean; onToggle: (id: string, hidden: boolean) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(interactionId, !isHidden); }}
      className={cn(
        "opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-accent",
        isHidden && "opacity-100"
      )}
      title={isHidden ? "Unhide" : "Hide"}
    >
      {isHidden ? <Undo2 className="h-3.5 w-3.5 text-muted-foreground" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
    </button>
  );
}

/* ── Single Entry Row ── */
function TimelineEntry({ item, defaultOpen, onToggleHide, showHidden }: { item: InteractionItem; defaultOpen: boolean; onToggleHide: (id: string, hidden: boolean) => void; showHidden: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tags = useMemo(() => getSignalTags(item), [item]);
  const isHidden = item.hidden;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn("group", isHidden && "opacity-50")}>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <ChannelBadge type={item.type} />
                  {item.source === "automation" && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                      <Zap className="h-2.5 w-2.5" />
                      Auto-sent
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(item.occurred_at), "MMM d · h:mm a")}
                  </span>
                  {item.ai_reply_worthy && (
                    <span className="text-[10px] font-medium text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                      Reply Needed
                    </span>
                  )}
                  {isHidden && (
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Hidden
                    </span>
                  )}
                </div>
                {item.subject && (
                  <p className={cn("text-sm font-medium text-foreground leading-snug truncate", isHidden && "line-through")}>
                    {item.subject}
                  </p>
                )}
                {!open && item.body_text && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {item.body_text}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 pt-1">
                <HideButton interactionId={item.id} isHidden={isHidden} onToggle={onToggleHide} />
                <span className="text-muted-foreground/50">
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </span>
              </div>
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="animate-accordion-down">
          <div className="pl-3 pb-2 space-y-2">
            {item.ai_summary && (
              <div className="bg-accent/50 rounded-md px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground mb-0.5">AI Summary</p>
                <p className="text-[13px] text-foreground leading-relaxed">{item.ai_summary}</p>
              </div>
            )}
            <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {item.body_text}
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
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/* ── Thread Group ── */
function ThreadEntry({ thread, defaultOpen, onToggleHide }: { thread: ThreadGroup; defaultOpen: boolean; onToggleHide: (id: string, hidden: boolean) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const latest = thread.latest;
  const tags = useMemo(() => getSignalTags(latest), [latest]);
  const isHidden = latest.hidden;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn("group", isHidden && "opacity-50")}>
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
                  {isHidden && (
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Hidden
                    </span>
                  )}
                </div>
                {latest.subject && (
                  <p className={cn("text-sm font-medium text-foreground leading-snug truncate", isHidden && "line-through")}>
                    {latest.subject}
                  </p>
                )}
                {!open && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {latest.body_text}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 pt-1">
                <HideButton interactionId={latest.id} isHidden={isHidden} onToggle={onToggleHide} />
                <span className="text-muted-foreground/50">
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </span>
              </div>
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="animate-accordion-down">
          <div className="pl-3 pb-2 space-y-2">
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
                      <div key={msg.id} className={cn("space-y-0.5 group/msg", msg.hidden && "opacity-50")}>
                        <div className="flex items-center gap-2">
                          <ChannelBadge type={msg.type} />
                          <span className="text-[11px] text-muted-foreground">
                            {format(new Date(msg.occurred_at), "MMM d · h:mm a")}
                          </span>
                          <HideButton interactionId={msg.id} isHidden={msg.hidden} onToggle={onToggleHide} />
                        </div>
                        <p className={cn("text-[13px] text-muted-foreground line-clamp-3 leading-relaxed", msg.hidden && "line-through")}>
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
function MeetingEntry({ item, defaultOpen, onToggleHide }: { item: InteractionItem; defaultOpen: boolean; onToggleHide: (id: string, hidden: boolean) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const isHidden = item.hidden;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn("group", isHidden && "opacity-50")}>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <ChannelBadge type="meeting" />
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(item.occurred_at), "MMM d")}
                  </span>
                  {isHidden && (
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Hidden
                    </span>
                  )}
                </div>
                {item.subject && (
                  <p className={cn("text-sm font-medium text-foreground leading-snug", isHidden && "line-through")}>{item.subject}</p>
                )}
                {!open && item.ai_summary && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {item.ai_summary}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 pt-1">
                <HideButton interactionId={item.id} isHidden={isHidden} onToggle={onToggleHide} />
                <span className="text-muted-foreground/50">
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </span>
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

/* ── WhatsApp Entry (chat-bubble style) ── */
function WhatsAppEntry({ item, onToggleHide }: { item: InteractionItem; onToggleHide: (id: string, hidden: boolean) => void }) {
  const isOutbound = item.type === "whatsapp_outbound";
  const isHidden = item.hidden;
  return (
    <div className={cn("py-3 px-3 -mx-3 group", isOutbound ? "flex justify-end" : "flex justify-start", isHidden && "opacity-50")}>
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
          <HideButton interactionId={item.id} isHidden={isHidden} onToggle={onToggleHide} />
        </div>
        <p className={cn("text-[13px] text-foreground leading-relaxed whitespace-pre-wrap", isHidden && "line-through")}>
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
  const [activeFilter, setActiveFilter] = useState<TimelineFilter>("all");
  const [showHidden, setShowHidden] = useState(false);

  const loadInteractions = () => {
    getLeadInteractions(leadId, showHidden)
      .then((items) => setInteractions(dedupeTimelineItems(items)))
      .catch(console.error)
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    loadInteractions();
  }, [leadId, showHidden]);

  const handleToggleHide = async (interactionId: string, hide: boolean) => {
    try {
      if (hide) {
        await hideInteraction(interactionId);
        toast.success("Interaction hidden");
      } else {
        await unhideInteraction(interactionId);
        toast.success("Interaction restored");
      }
      loadInteractions();
    } catch (err) {
      console.error("[TimelineTab] Hide toggle error:", err);
      toast.error("Failed to update interaction");
    }
  };

  const handleLogWhatsAppReply = async () => {
    if (!replyText.trim()) return;
    setIsSavingReply(true);
    try {
      await supabase.from("interactions").insert({
        lead_id: leadId,
        type: "whatsapp_inbound",
        source: "manual",
        body_text: replyText.trim(),
        direction: "inbound",
        occurred_at: new Date().toISOString(),
      });

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

  // Apply type filter
  const filteredInteractions = useMemo(() => {
    if (activeFilter === "all") return interactions;
    return interactions.filter(i => matchesFilter(i.type, i.source || "", activeFilter));
  }, [interactions, activeFilter]);

  const entries = useMemo(() => groupIntoThreads(filteredInteractions), [filteredInteractions]);
  const autoExpand = useMemo(() => getAutoExpandIds(entries), [entries]);

  const hiddenCount = useMemo(() => interactions.filter(i => i.hidden).length, [interactions]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground py-8">Loading interactions...</p>;
  }

  if (interactions.length === 0 && !showHidden) {
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
      {/* Filter bar */}
      <div className="flex items-center gap-2 pb-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-1 flex-wrap">
          {FILTER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setActiveFilter(opt.value)}
              className={cn(
                "text-[12px] font-medium px-3 py-1 rounded-full border transition-colors",
                activeFilter === opt.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/50 text-muted-foreground border-border hover:bg-accent hover:text-foreground"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHidden(!showHidden)}
            className={cn(
              "text-[11px] flex items-center gap-1 px-2 py-1 rounded border transition-colors",
              showHidden
                ? "bg-accent text-foreground border-border"
                : "text-muted-foreground border-transparent hover:text-foreground"
            )}
          >
            {showHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            {showHidden ? "Showing hidden" : `${hiddenCount > 0 ? hiddenCount + " hidden" : "Show hidden"}`}
          </button>

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

      {entries.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">No matching interactions.</p>
      )}

      {entries.map((entry, idx) => {
        const key = isThread(entry) ? entry.key : entry.id;
        const isExpanded = autoExpand.has(key);
        const isWhatsApp = !isThread(entry) && (entry.type === "whatsapp_inbound" || entry.type === "whatsapp_outbound");

        return (
          <div key={key}>
            {idx > 0 && <div className="border-t border-border/50 mx-0" />}
            {isThread(entry) ? (
              <ThreadEntry thread={entry} defaultOpen={isExpanded} onToggleHide={handleToggleHide} />
            ) : entry.type === "meeting" ? (
              <MeetingEntry item={entry} defaultOpen={isExpanded} onToggleHide={handleToggleHide} />
            ) : isWhatsApp ? (
              <WhatsAppEntry item={entry} onToggleHide={handleToggleHide} />
            ) : (
              <TimelineEntry item={entry} defaultOpen={isExpanded} onToggleHide={handleToggleHide} showHidden={showHidden} />
            )}
          </div>
        );
      })}
    </div>
  );
}
