import { useEffect, useMemo, useState } from "react";
import { getLeadTimeline, hideTimelineItem, unhideTimelineItem, type TimelineItem } from "@/lib/supabaseQueries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { Mail, MailOpen, Calendar, Phone, StickyNote, Settings2, ChevronDown, ChevronRight, MessageSquare, Smartphone, Plus, EyeOff, Eye, Undo2, Zap } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import CallTimelineCard from "@/components/call/CallTimelineCard";

interface TimelineTabProps {
  leadId: string;
  onWhatsAppReply?: () => void;
}

/* ── Filter types ── */
type TimelineFilter = "all" | "emails" | "sms" | "whatsapp" | "meetings" | "calls" | "notes" | "automation";

const FILTER_OPTIONS: { value: TimelineFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "emails", label: "Emails" },
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "calls", label: "Calls" },
  { value: "meetings", label: "Meetings" },
  { value: "notes", label: "Notes" },
  { value: "automation", label: "Automation" },
];

function filterToChannel(filter: TimelineFilter): string | undefined {
  if (filter === "emails") return "email";
  if (filter === "sms") return "sms";
  if (filter === "whatsapp") return "whatsapp";
  if (filter === "calls") return "voice";
  if (filter === "meetings") return "meeting";
  if (filter === "notes") return "system";
  return undefined;
}

function matchesFilter(item: TimelineItem, filter: TimelineFilter): boolean {
  if (filter === "all") return true;
  if (filter === "automation") return item.provider === "automation" || (item.metadata_json as any)?.source === "automation";
  const ch = filterToChannel(filter);
  return ch ? item.channel === ch : true;
}

/* ── Thread grouping by normalized subject ── */
interface ThreadGroup {
  key: string;
  items: TimelineItem[];
  latest: TimelineItem;
}

function normalizeSubject(s: string | null): string {
  if (!s) return "";
  return s.replace(/^(re|fw|fwd):\s*/gi, "").trim().toLowerCase();
}

function groupIntoThreads(items: TimelineItem[]): (TimelineItem | ThreadGroup)[] {
  const emailItems = items.filter(i => i.channel === "email" && i.event_type !== "system_note");
  const nonEmailItems = items.filter(i => i.channel !== "email" || i.event_type === "system_note");

  const threadMap = new Map<string, TimelineItem[]>();
  for (const item of emailItems) {
    const key = normalizeSubject(item.subject) || item.id;
    const existing = threadMap.get(key);
    if (existing) existing.push(item);
    else threadMap.set(key, [item]);
  }

  const threads: (TimelineItem | ThreadGroup)[] = [];
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
    const tsA = 'latest' in a ? new Date(a.latest.occurred_at).getTime() : new Date((a as TimelineItem).occurred_at).getTime();
    const tsB = 'latest' in b ? new Date(b.latest.occurred_at).getTime() : new Date((b as TimelineItem).occurred_at).getTime();
    return tsB - tsA;
  });

  return all;
}

function isThread(entry: TimelineItem | ThreadGroup): entry is ThreadGroup {
  return 'items' in entry;
}

/* ── Auto-expand ── */
function getAutoExpandIds(entries: (TimelineItem | ThreadGroup)[]): Set<string> {
  const ids = new Set<string>();
  let foundInbound = false, foundOutbound = false, foundMeeting = false, foundWhatsApp = false;

  for (const entry of entries) {
    if (isThread(entry)) {
      const latest = entry.latest;
      if (!foundInbound && latest.direction === "inbound" && latest.channel === "email") { ids.add(entry.key); foundInbound = true; }
      if (!foundOutbound && latest.direction === "outbound" && latest.channel === "email") { ids.add(entry.key); foundOutbound = true; }
    } else {
      if (!foundInbound && entry.direction === "inbound" && entry.channel === "email") { ids.add(entry.id); foundInbound = true; }
      if (!foundOutbound && entry.direction === "outbound" && entry.channel === "email") { ids.add(entry.id); foundOutbound = true; }
      if (!foundMeeting && entry.channel === "meeting") { ids.add(entry.id); foundMeeting = true; }
      if (!foundWhatsApp && entry.channel === "whatsapp") { ids.add(entry.id); foundWhatsApp = true; }
    }
    if (foundInbound && foundOutbound && foundMeeting && foundWhatsApp) break;
  }
  return ids;
}

/* ── Signal tags ── */
function getSignalTags(item: TimelineItem): string[] {
  const tags: string[] = [];
  const meta = item.metadata_json as any;
  if (meta?.ai_intent) tags.push(meta.ai_intent);
  const bodyLower = (item.snippet_text || "").toLowerCase();
  if (bodyLower.includes("pricing") || bodyLower.includes("price") || bodyLower.includes("cost")) tags.push("Pricing Mentioned");
  if (bodyLower.includes("decision") || bodyLower.includes("approve") || bodyLower.includes("sign off")) tags.push("Decision Maker Involved");
  if (bodyLower.includes("concern") || bodyLower.includes("issue") || bodyLower.includes("problem")) tags.push("Objection Raised");
  return [...new Set(tags)];
}

/* ── Channel badge ── */
function ChannelBadge({ item }: { item: TimelineItem }) {
  const eventType = item.event_type;
  const channel = item.channel;
  const direction = item.direction;

  const config: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
    email_inbound: { icon: <MailOpen className="h-3 w-3" />, label: "Inbound", className: "text-emerald-600 bg-emerald-500/10 border-emerald-500/20" },
    email_outbound: { icon: <Mail className="h-3 w-3" />, label: "Outbound", className: "text-blue-600 bg-blue-500/10 border-blue-500/20" },
    meeting: { icon: <Calendar className="h-3 w-3" />, label: "Meeting", className: "text-purple-600 bg-purple-500/10 border-purple-500/20" },
    phone_call: { icon: <Phone className="h-3 w-3" />, label: "Call", className: "text-amber-600 bg-amber-500/10 border-amber-500/20" },
    whatsapp_outbound: { icon: <MessageSquare className="h-3 w-3" />, label: "WhatsApp", className: "text-green-600 bg-green-500/10 border-green-500/20" },
    whatsapp_inbound: { icon: <MessageSquare className="h-3 w-3" />, label: "WhatsApp", className: "text-green-600 bg-green-500/10 border-green-500/20" },
    sms_outbound: { icon: <Smartphone className="h-3 w-3" />, label: "SMS Out", className: "text-sky-600 bg-sky-500/10 border-sky-500/20" },
    sms_inbound: { icon: <Smartphone className="h-3 w-3" />, label: "SMS In", className: "text-teal-600 bg-teal-500/10 border-teal-500/20" },
    note: { icon: <StickyNote className="h-3 w-3" />, label: "Note", className: "text-muted-foreground bg-muted border-border" },
    system_note: { icon: <Settings2 className="h-3 w-3" />, label: "System", className: "text-muted-foreground bg-muted border-border" },
  };

  // Resolve key from event_type first, then channel+direction
  let key = eventType;
  if (!config[key]) {
    if (channel === "email") key = direction === "inbound" ? "email_inbound" : "email_outbound";
    else if (channel === "sms") key = direction === "inbound" ? "sms_inbound" : "sms_outbound";
    else if (channel === "whatsapp") key = direction === "inbound" ? "whatsapp_inbound" : "whatsapp_outbound";
    else if (channel === "voice") key = "phone_call";
    else if (channel === "meeting") key = "meeting";
    else key = "note";
  }

  const c = config[key] || config.note;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border", c.className)}>
      {c.icon}
      {c.label}
    </span>
  );
}

/* ── Hide button ── */
function HideButton({ itemId, isHidden, onToggle }: { itemId: string; isHidden: boolean; onToggle: (id: string, hidden: boolean) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(itemId, !isHidden); }}
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

/* ── Format system_note body ── */
function formatSnippet(item: TimelineItem): string {
  const text = item.snippet_text || "";
  if (item.event_type !== "system_note" || !text.trim().startsWith("{")) return text;
  try {
    const data = JSON.parse(text);
    if (data.event === "intent_override") {
      const NAMES: Record<string, string> = {
        pre_email_1_intro: "Intro Email",
        pre_email_2_followup: "Follow-up 1",
        pre_email_3_followup: "Follow-up 2",
        pre_email_4_breakup: "Breakup Email",
      };
      return `Sequence override: suggested "${NAMES[data.suggested_intent] || data.suggested_intent}" → chose "${NAMES[data.chosen_intent] || data.chosen_intent}"`;
    }
    return text;
  } catch {
    return text;
  }
}

/* ── Single Entry Row ── */
function TimelineEntry({ item, defaultOpen, onToggleHide, showHidden }: { item: TimelineItem; defaultOpen: boolean; onToggleHide: (id: string, hidden: boolean) => void; showHidden: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tags = useMemo(() => getSignalTags(item), [item]);
  const meta = item.metadata_json as any;
  const isAutomation = item.provider === "automation" || meta?.source === "automation";
  const aiReplyWorthy = (item.status_json as any)?.ai_reply_worthy;
  const aiSummary = meta?.ai_summary;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn("group", item.hidden && "opacity-50")}>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <ChannelBadge item={item} />
                  {isAutomation && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                      <Zap className="h-2.5 w-2.5" />
                      Auto-sent
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(item.occurred_at), "MMM d · h:mm a")}
                  </span>
                  {aiReplyWorthy && (
                    <span className="text-[10px] font-medium text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                      Reply Needed
                    </span>
                  )}
                  {item.hidden && (
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Hidden
                    </span>
                  )}
                </div>
                {item.subject && (
                  <p className={cn("text-sm font-medium text-foreground leading-snug truncate", item.hidden && "line-through")}>
                    {item.subject}
                  </p>
                )}
                {!open && item.snippet_text && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {formatSnippet(item)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 pt-1">
                <HideButton itemId={item.id} isHidden={item.hidden} onToggle={onToggleHide} />
                <span className="text-muted-foreground/50">
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </span>
              </div>
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="animate-accordion-down">
          <div className="pl-3 pb-2 space-y-2">
            {aiSummary && (
              <div className="bg-accent/50 rounded-md px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground mb-0.5">AI Summary</p>
                <p className="text-[13px] text-foreground leading-relaxed">{aiSummary}</p>
              </div>
            )}
            <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {formatSnippet(item)}
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
  const meta = latest.metadata_json as any;
  const aiReplyWorthy = (latest.status_json as any)?.ai_reply_worthy;
  const aiSummary = meta?.ai_summary;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn("group", latest.hidden && "opacity-50")}>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <ChannelBadge item={latest} />
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(latest.occurred_at), "MMM d · h:mm a")}
                  </span>
                  <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full border border-border">
                    Thread ({thread.items.length})
                  </span>
                  {aiReplyWorthy && (
                    <span className="text-[10px] font-medium text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                      Reply Needed
                    </span>
                  )}
                  {latest.hidden && (
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Hidden
                    </span>
                  )}
                </div>
                {latest.subject && (
                  <p className={cn("text-sm font-medium text-foreground leading-snug truncate", latest.hidden && "line-through")}>
                    {latest.subject}
                  </p>
                )}
                {!open && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {latest.snippet_text}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 pt-1">
                <HideButton itemId={latest.id} isHidden={latest.hidden} onToggle={onToggleHide} />
                <span className="text-muted-foreground/50">
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </span>
              </div>
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="animate-accordion-down">
          <div className="pl-3 pb-2 space-y-2">
            {aiSummary && (
              <div className="bg-accent/50 rounded-md px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground mb-0.5">AI Summary</p>
                <p className="text-[13px] text-foreground leading-relaxed">{aiSummary}</p>
              </div>
            )}
            <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed line-clamp-4">
              {latest.snippet_text}
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
                          <ChannelBadge item={msg} />
                          <span className="text-[11px] text-muted-foreground">
                            {format(new Date(msg.occurred_at), "MMM d · h:mm a")}
                          </span>
                          <HideButton itemId={msg.id} isHidden={msg.hidden} onToggle={onToggleHide} />
                        </div>
                        <p className={cn("text-[13px] text-muted-foreground line-clamp-3 leading-relaxed", msg.hidden && "line-through")}>
                          {msg.snippet_text}
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

/* ── Meeting Entry ── */
function MeetingEntry({ item, defaultOpen, onToggleHide }: { item: TimelineItem; defaultOpen: boolean; onToggleHide: (id: string, hidden: boolean) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = item.metadata_json as any;
  const aiSummary = meta?.ai_summary || meta?.summary_text;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn("group", item.hidden && "opacity-50")}>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <ChannelBadge item={item} />
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(item.occurred_at), "MMM d")}
                  </span>
                  {item.hidden && (
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Hidden
                    </span>
                  )}
                </div>
                {item.subject && (
                  <p className={cn("text-sm font-medium text-foreground leading-snug", item.hidden && "line-through")}>{item.subject}</p>
                )}
                {!open && aiSummary && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {aiSummary}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 pt-1">
                <HideButton itemId={item.id} isHidden={item.hidden} onToggle={onToggleHide} />
                <span className="text-muted-foreground/50">
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </span>
              </div>
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="animate-accordion-down">
          <div className="pl-3 pb-2 space-y-2">
            {aiSummary && (
              <p className="text-[13px] text-foreground leading-relaxed">{aiSummary}</p>
            )}
            {item.snippet_text && (
              <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {item.snippet_text}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/* ── WhatsApp Entry ── */
function WhatsAppEntry({ item, onToggleHide }: { item: TimelineItem; onToggleHide: (id: string, hidden: boolean) => void }) {
  const isOutbound = item.direction === "outbound";
  return (
    <div className={cn("py-3 px-3 -mx-3 group", isOutbound ? "flex justify-end" : "flex justify-start", item.hidden && "opacity-50")}>
      <div className={cn(
        "max-w-[80%] rounded-2xl px-4 py-2.5 space-y-1",
        isOutbound ? "bg-primary/10 rounded-br-md" : "bg-accent rounded-bl-md"
      )}>
        <div className="flex items-center gap-2">
          <ChannelBadge item={item} />
          <span className="text-[11px] text-muted-foreground">
            {format(new Date(item.occurred_at), "MMM d · h:mm a")}
          </span>
          <HideButton itemId={item.id} isHidden={item.hidden} onToggle={onToggleHide} />
        </div>
        <p className={cn("text-[13px] text-foreground leading-relaxed whitespace-pre-wrap", item.hidden && "line-through")}>
          {item.snippet_text}
        </p>
      </div>
    </div>
  );
}

/* ── Call Entry (from ledger) ── */
function CallEntry({ item, onToggleHide }: { item: TimelineItem; onToggleHide: (id: string, hidden: boolean) => void }) {
  const meta = item.metadata_json as any;
  const duration = meta?.duration_sec;
  const summary = meta?.summary_short;

  return (
    <div className={cn("group py-3 px-3 -mx-3", item.hidden && "opacity-50")}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <ChannelBadge item={item} />
            <span className="text-[11px] text-muted-foreground">
              {format(new Date(item.occurred_at), "MMM d · h:mm a")}
            </span>
            {duration && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full border border-border">
                {Math.round(duration / 60)}m {duration % 60}s
              </span>
            )}
          </div>
          {item.subject && <p className="text-sm font-medium text-foreground">{item.subject}</p>}
          {summary && <p className="text-[13px] text-muted-foreground line-clamp-2">{summary}</p>}
          {item.snippet_text && !summary && <p className="text-[13px] text-muted-foreground line-clamp-2">{item.snippet_text}</p>}
        </div>
        <HideButton itemId={item.id} isHidden={item.hidden} onToggle={onToggleHide} />
      </div>
    </div>
  );
}

/* ── Main Component ── */
export default function TimelineTab({ leadId, onWhatsAppReply }: TimelineTabProps) {
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isSavingReply, setIsSavingReply] = useState(false);
  const [activeFilter, setActiveFilter] = useState<TimelineFilter>("all");
  const [showHidden, setShowHidden] = useState(false);

  const loadTimeline = () => {
    setIsLoading(true);
    getLeadTimeline(leadId, { includeHidden: showHidden })
      .then(items => setTimelineItems(items))
      .catch(console.error)
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    loadTimeline();
  }, [leadId, showHidden]);

  const handleToggleHide = async (itemId: string, hide: boolean) => {
    try {
      if (hide) {
        await hideTimelineItem(itemId);
        toast.success("Item hidden");
      } else {
        await unhideTimelineItem(itemId);
        toast.success("Item restored");
      }
      loadTimeline();
    } catch (err) {
      console.error("[TimelineTab] Hide toggle error:", err);
      toast.error("Failed to update item");
    }
  };

  const handleLogWhatsAppReply = async () => {
    if (!replyText.trim()) return;
    setIsSavingReply(true);
    try {
      // Write to legacy interactions (bridge path — kept until interactions table is removed)
      const occurredAt = new Date().toISOString();
      const { data: interactionRow } = await supabase.from("interactions").insert({
        lead_id: leadId,
        type: "whatsapp_inbound",
        source: "manual",
        body_text: replyText.trim(),
        direction: "inbound",
        occurred_at: occurredAt,
      }).select("id").single();

      // Also project to canonical lead_timeline_items ledger
      if (interactionRow) {
        // Get lead's workspace_id for the timeline item
        const { data: leadData } = await supabase
          .from("leads")
          .select("workspace_id")
          .eq("id", leadId)
          .single();

        if (leadData?.workspace_id) {
          const dedupeKey = `wa:inbound:manual:${interactionRow.id}`;
          await supabase.from("lead_timeline_items").upsert({
            workspace_id: leadData.workspace_id,
            lead_id: leadId,
            channel: "whatsapp",
            provider: "manual",
            direction: "inbound",
            event_type: "whatsapp_inbound",
            occurred_at: occurredAt,
            source_table: "interactions",
            source_id: interactionRow.id,
            snippet_text: replyText.trim().substring(0, 500),
            dedupe_key: dedupeKey,
          }, { onConflict: "lead_id,dedupe_key" });
        }
      }

      await supabase.from("leads").update({
        last_inbound_at: occurredAt,
        last_activity_at: occurredAt,
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
      loadTimeline();
      onWhatsAppReply?.();
    } catch (err) {
      console.error("[TimelineTab] WhatsApp reply log error:", err);
      toast.error("Failed to log reply");
    } finally {
      setIsSavingReply(false);
    }
  };

  // Apply filter
  const filteredItems = useMemo(() => {
    if (activeFilter === "all") return timelineItems;
    return timelineItems.filter(i => matchesFilter(i, activeFilter));
  }, [timelineItems, activeFilter]);

  const entries = useMemo(() => groupIntoThreads(filteredItems), [filteredItems]);
  const autoExpand = useMemo(() => getAutoExpandIds(entries), [entries]);

  const hiddenCount = useMemo(() => timelineItems.filter(i => i.hidden).length, [timelineItems]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground py-8">Loading timeline...</p>;
  }

  if (timelineItems.length === 0 && !showHidden) {
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

      {/* Unified timeline from ledger */}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No matching interactions.</p>
      ) : (
        entries.map((entry, idx) => {
          const key = isThread(entry) ? entry.key : entry.id;
          const isExpanded = autoExpand.has(key);

          return (
            <div key={key}>
              {idx > 0 && <div className="border-t border-border/50 mx-0" />}
              {isThread(entry) ? (
                <ThreadEntry thread={entry} defaultOpen={isExpanded} onToggleHide={handleToggleHide} />
              ) : entry.channel === "meeting" ? (
                <MeetingEntry item={entry} defaultOpen={isExpanded} onToggleHide={handleToggleHide} />
              ) : entry.channel === "whatsapp" ? (
                <WhatsAppEntry item={entry} onToggleHide={handleToggleHide} />
              ) : entry.channel === "voice" ? (
                <CallEntry item={entry} onToggleHide={handleToggleHide} />
              ) : (
                <TimelineEntry item={entry} defaultOpen={isExpanded} onToggleHide={handleToggleHide} showHidden={showHidden} />
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
