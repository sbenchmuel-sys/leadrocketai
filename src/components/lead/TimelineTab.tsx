import { useEffect, useMemo, useState, useCallback } from "react";
import { getLeadTimeline, getGroupTimelineItems, setTimelineFollowupState, hideTimelineItem, unhideTimelineItem, insertInteraction, type TimelineItem } from "@/lib/supabaseQueries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { Mail, MailOpen, Calendar, Phone, StickyNote, Settings2, ChevronDown, ChevronRight, MessageSquare, Smartphone, Plus, EyeOff, Eye, Undo2, Download, FileText, Reply, Clock, SlidersHorizontal, X } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import CallTimelineCard from "@/components/call/CallTimelineCard";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { EmailActionDialog } from "@/components/dashboard/EmailActionDialog";
import { SummaryBody } from "@/components/SummaryBody";
import { stripEmailDisclaimer, relativeTimeShort, oneLineGist } from "@/lib/timelineDisplay";

// PR 2.4 — minimal lead shape passed to EmailActionDialog when user clicks
// Reply/Follow-up. Group view fetches all members up front; solo view uses
// the parent-supplied currentLead.
export interface TimelineMinimalLead {
  id: string;
  name: string;
  company: string;
  email: string;
  stage: string;
  motion?: string;
  job_title?: string | null;
  unsubscribed?: boolean;
}

interface TimelineTabProps {
  leadId: string;
  onWhatsAppReply?: () => void;
  // PR 2.4 — when set, TimelineTab loads the union timeline across every lead
  // in this group (champion + stakeholders) and renders lead-name chips.
  groupId?: string | null;
  // PR 2.4 — current lead (for solo path + as fallback in group path).
  currentLead?: TimelineMinimalLead;
}

// PR 2.4 — bounce/no-reply sender filter for the Reply visibility rule.
const BOUNCE_FROM_REGEX = /^(postmaster|mailer-daemon|mailerdaemon|noreply|no-reply|donotreply|do-not-reply|bounce)([._\-+]|@)/i;
// Lightweight subject-side OOO check (mirror of supabase/functions/_shared/oooDetection.ts subject patterns).
const OOO_SUBJECT_REGEX = /(out of office|\bOOO\b|auto.?reply|automatic reply|on vacation|currently away|currently unavailable|annual leave|on leave|holiday notification)/i;
// Visible-by-default cutoff for the Follow-up button.
const FOLLOWUP_THRESHOLD_DAYS = 5;
// Pulsing-ring window — emphasises the freshest unreplied inbound for the
// first N hours after it arrives. Toned-down: static ring, no animation.
const FRESH_INBOUND_RING_HOURS = 6;

/**
 * Extract the bare email address from an RFC 2822 `from`/`to` header value.
 * Handles plain ("a@b.com"), display-name+angle ("Name <a@b.com>"), and
 * quoted display ("\"Name\" <a@b.com>"). Falls back to lowercase-of-input
 * for malformed/empty input. Always returns lowercase.
 */
function extractBareEmail(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Display-name with angle brackets: "Name <addr>" or "\"Name\" <addr>".
  const angle = /<\s*([^>\s]+@[^>\s]+)\s*>/.exec(trimmed);
  if (angle && angle[1]) return angle[1].toLowerCase();
  // Plain email anywhere in the string.
  const plain = /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/.exec(trimmed);
  if (plain && plain[1]) return plain[1].toLowerCase();
  return trimmed.toLowerCase();
}

function fromEmailLower(item: TimelineItem): string {
  const meta = (item.metadata_json as Record<string, unknown> | null) ?? {};
  return extractBareEmail(meta.from_email as string | undefined);
}

function toEmailsLower(item: TimelineItem): string[] {
  const meta = (item.metadata_json as Record<string, unknown> | null) ?? {};
  const arr = Array.isArray(meta.to_emails) ? (meta.to_emails as string[]) : [];
  // Each entry in to_emails may itself be RFC-2822 formatted depending on
  // which writer populated it. Normalize via extractBareEmail so the
  // To-based clearing rule isn't fooled by display-name wrappers.
  return arr.map(extractBareEmail).filter(Boolean);
}

// Thread-scope key for Reply visibility — prefer the provider thread/
// conversation id (so forwards with the same normalized subject don't
// accidentally group together), fall back to normalized subject for
// legacy rows missing that metadata.
function threadKeyOf(item: TimelineItem): string {
  const meta = (item.metadata_json as Record<string, unknown> | null) ?? {};
  const gid = meta.gmail_thread_id as string | undefined;
  const cid = meta.conversation_id as string | undefined;
  return gid || cid || normalizeSubject(item.subject) || item.id;
}

/** Reply visibility rule (PR 2.4 §1). Per-thread scoping for inbounds —
 *  only the most-recent unreplied inbound per (sender, thread) qualifies.
 *  Now also respects the per-row snooze/dismiss state stored in
 *  timeline_followup_state. */
function canShowReply(item: TimelineItem, all: TimelineItem[], leadUnsubscribed: boolean): boolean {
  if (item.event_type !== "email_inbound") return false;
  const sender = fromEmailLower(item);
  if (!sender) return false;
  if (BOUNCE_FROM_REGEX.test(sender)) return false;
  if (item.subject && OOO_SUBJECT_REGEX.test(item.subject)) return false;
  if (leadUnsubscribed) return false;

  // PR 2.4 follow-up — Reply popover allows snooze/dismiss too. Mirrors
  // followupVisibility's snooze/dismiss checks on the same columns.
  if (item.followup_snoozed_until && new Date(item.followup_snoozed_until).getTime() > Date.now()) return false;
  if (item.followup_dismissed_at) return false;

  const tk = threadKeyOf(item);
  const inThread = all.filter(o => threadKeyOf(o) === tk);

  // Most recent inbound from THIS sender within the thread?
  const senderInbounds = inThread
    .filter(i => i.event_type === "email_inbound" && fromEmailLower(i) === sender)
    .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  if (senderInbounds.length === 0 || senderInbounds[0].id !== item.id) return false;

  // No later outbound in the same thread that addressed this sender on To.
  // (Cc explicitly does NOT clear — only To clears.)
  const ts = new Date(item.occurred_at).getTime();
  const laterOutboundAddressing = inThread.some(o =>
    o.event_type === "email_outbound"
    && new Date(o.occurred_at).getTime() > ts
    && toEmailsLower(o).some(e => e === sender),
  );
  return !laterOutboundAddressing;
}

/** Follow-up button visibility (PR 2.4 §2 + bug-fix v2).
 *
 *  Per-lead rule — at most one always-visible Follow-up per lead. Older
 *  outbounds and parallel threads still surface on hover. We deliberately
 *  do NOT thread-scope here; "most recent outbound to this lead" is
 *  computed across every thread the lead is in, so a lead with five
 *  parallel threads still sees exactly one always-visible Follow-up. */
function followupVisibility(item: TimelineItem, all: TimelineItem[]): "always" | "hover" | "never" {
  if (item.event_type !== "email_outbound") return "never";

  // Snoozed or dismissed → hover (user can still circle back manually).
  if (item.followup_snoozed_until && new Date(item.followup_snoozed_until).getTime() > Date.now()) return "hover";
  if (item.followup_dismissed_at) return "hover";

  const ts = new Date(item.occurred_at).getTime();
  const leadItems = all.filter(o => o.lead_id === item.lead_id);

  // Not the most recent outbound to this lead (across ALL their threads) → hover.
  const laterOutboundForLead = leadItems.some(o =>
    o.event_type === "email_outbound" && new Date(o.occurred_at).getTime() > ts,
  );
  if (laterOutboundForLead) return "hover";

  // Any later inbound from this lead, anywhere in their timeline → hover.
  const laterInboundForLead = leadItems.some(i =>
    i.event_type === "email_inbound" && new Date(i.occurred_at).getTime() > ts,
  );
  if (laterInboundForLead) return "hover";

  // <5 days old → hover (too soon to chase).
  const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  if (ageDays < FOLLOWUP_THRESHOLD_DAYS) return "hover";

  return "always";
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

/* ── Unit 2 — display helpers (who · body · gist) ── */

function nameFromEmail(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  // "Display Name <addr>" → Display Name
  const angle = /^\s*"?([^"<]+?)"?\s*</.exec(trimmed);
  if (angle && angle[1] && angle[1].trim() && !angle[1].includes("@")) return angle[1].trim();
  // bare email → prettified local part
  const local = extractBareEmail(trimmed).split("@")[0] || "";
  if (!local) return "";
  return local.replace(/[._-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function channelIconFor(item: TimelineItem) {
  const ch = item.channel;
  if (ch === "email") return item.direction === "inbound" ? <MailOpen className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />;
  if (ch === "whatsapp") return <MessageSquare className="h-3.5 w-3.5" />;
  if (ch === "sms") return <Smartphone className="h-3.5 w-3.5" />;
  if (ch === "voice") return <Phone className="h-3.5 w-3.5" />;
  if (ch === "meeting") return <Calendar className="h-3.5 w-3.5" />;
  return <StickyNote className="h-3.5 w-3.5" />;
}

function whoTextFor(item: TimelineItem, currentLead?: TimelineMinimalLead | null): string {
  if (item.event_type === "system_note") return "Update";
  if (item.channel === "meeting") return "Meeting";
  if (item.channel === "voice") return "Call";
  if (item.event_type === "note") return "Note";
  if (item.direction === "outbound") return "You";
  // inbound message → the person who reached out
  const meta = item.metadata_json as Record<string, unknown> | null;
  return (
    item.lead_name ||
    currentLead?.name ||
    nameFromEmail(meta?.from_email as string | undefined) ||
    "Them"
  );
}

/** Who said it — a small channel icon + person/"You". Replaces the colored
 *  Inbound/Outbound/SMS direction badges on conversation rows. */
function WhoLabel({ item, currentLead }: { item: TimelineItem; currentLead?: TimelineMinimalLead | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="text-muted-foreground shrink-0">{channelIconFor(item)}</span>
      <span className="text-sm font-medium text-foreground truncate">{whoTextFor(item, currentLead)}</span>
    </span>
  );
}

/** Relative time with the exact timestamp kept on hover. */
function RelTime({ at }: { at: string }) {
  return (
    <span className="text-[11px] text-muted-foreground shrink-0" title={format(new Date(at), "MMM d, yyyy · h:mm a")}>
      {relativeTimeShort(at)}
    </span>
  );
}

/** Full message body for display: system notes via formatSnippet, emails with
 *  the confidentiality footer stripped, everything else as-is. Display only —
 *  the stored body is never modified. */
function displayBodyFor(item: TimelineItem): string {
  if (item.event_type === "system_note") return formatSnippet(item);
  if (item.channel === "email") return stripEmailDisclaimer(item.snippet_text);
  return item.snippet_text || "";
}

/** One-line gist for the collapsed row — prefers the message text, falls back
 *  to the AI summary when the body is empty (e.g. retention-purged). */
function gistFor(item: TimelineItem): string {
  const body = displayBodyFor(item);
  if (body.trim()) return oneLineGist(body);
  const meta = item.metadata_json as Record<string, unknown> | null;
  return oneLineGist((meta?.ai_summary as string | undefined) || "");
}

// Below this body length, a separate AI-summary box just repeats the message,
// so we drop it; above it the boxed summary helps scan a long thread.
const LONG_BODY_CHARS = 280;

/* ── PR 2.4 — Reply / Follow-up sub-components ── */

export interface RowActions {
  /** Open EmailActionDialog as Reply targeting this row. */
  onReply: (item: TimelineItem) => void;
  /** Open EmailActionDialog as Follow-up targeting this row. */
  onFollowup: (item: TimelineItem) => void;
  /** Snooze the reminder on this row (works for inbound Reply or outbound Follow-up). */
  onSnoozeRow: (item: TimelineItem, days: number) => void;
  /** Dismiss the reminder permanently (with 5s undo toast). Same row scope as snooze. */
  onDismissRow: (item: TimelineItem) => void;
}

/** Shared Snooze/Dismiss popover used by both Reply and Follow-up buttons.
 *  Renders the caret split + the Popover content. */
function SnoozeDismissPopover({
  item,
  actions,
  caretClass,
  popoverWidthClass = "w-44",
}: {
  item: TimelineItem;
  actions: RowActions;
  caretClass: string;
  popoverWidthClass?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className={caretClass}
          title="Snooze or dismiss"
          aria-label="Snooze or dismiss this reminder"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={cn(popoverWidthClass, "p-1")}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">Snooze for…</p>
        {[3, 5, 7].map(days => (
          <button
            key={days}
            onClick={() => { setOpen(false); actions.onSnoozeRow(item, days); }}
            className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-accent"
          >
            {days} days
          </button>
        ))}
        <div className="my-1 border-t border-border" />
        <button
          onClick={() => { setOpen(false); actions.onDismissRow(item); }}
          className="w-full text-left px-2 py-1.5 text-xs rounded text-destructive hover:bg-destructive/10"
        >
          Dismiss
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** Reply — filled split button. Always-visible when the visibility rule
 *  passes (no hover-reveal). The caret opens the Snooze/Dismiss popover
 *  shared with Follow-up. */
function ReplyButton({ item, actions }: { item: TimelineItem; actions: RowActions }) {
  return (
    <div className="inline-flex items-stretch rounded-md overflow-hidden bg-primary/90 hover:bg-primary text-primary-foreground shadow-sm transition-colors">
      <button
        onClick={(e) => { e.stopPropagation(); actions.onReply(item); }}
        className="inline-flex items-center gap-1 px-2.5 h-[22px] text-[10px] font-medium"
        title="Reply"
      >
        <Reply className="h-3 w-3" />
        Reply
      </button>
      <SnoozeDismissPopover
        item={item}
        actions={actions}
        caretClass="inline-flex items-center justify-center px-1 h-[22px] border-l border-primary-foreground/20 hover:bg-primary"
      />
    </div>
  );
}

/** Follow-up — ghost split button. No background at rest; subtle border
 *  + foreground colour-shift on hover. Hidden by default + revealed on
 *  hover when `visibility === "hover"`. */
function FollowupButton({
  item,
  visibility,
  actions,
}: {
  item: TimelineItem;
  visibility: "always" | "hover";
  actions: RowActions;
}) {
  const wrapperClass = cn(
    "inline-flex items-stretch rounded-md overflow-hidden text-muted-foreground",
    "hover:text-foreground hover:border hover:border-border transition-colors",
    visibility === "hover" && "opacity-0 group-hover:opacity-100",
  );

  return (
    <div className={wrapperClass}>
      <button
        onClick={(e) => { e.stopPropagation(); actions.onFollowup(item); }}
        className="inline-flex items-center gap-1 px-2 h-[22px] text-[10px] font-medium hover:bg-accent/40"
        title="Follow up on this email"
      >
        <Clock className="h-3 w-3" />
        Follow up
      </button>
      <SnoozeDismissPopover
        item={item}
        actions={actions}
        caretClass="inline-flex items-center justify-center px-1 h-[22px] border-l border-border/60 hover:bg-accent/40"
      />
    </div>
  );
}

function LeadChip({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return (
    <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground border border-border">
      {name}
    </span>
  );
}

/* ── Single Entry Row ── */
function TimelineEntry({
  item,
  defaultOpen,
  onToggleHide,
  showHidden,
  allItems,
  leadUnsubscribedById,
  groupMode,
  actions,
  freshestRingId,
  currentLead,
}: {
  item: TimelineItem;
  defaultOpen: boolean;
  onToggleHide: (id: string, hidden: boolean) => void;
  showHidden: boolean;
  allItems: TimelineItem[];
  leadUnsubscribedById: Map<string, boolean>;
  groupMode: boolean;
  actions: RowActions;
  freshestRingId: string | null;
  currentLead?: TimelineMinimalLead | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const tags = useMemo(() => getSignalTags(item), [item]);
  const meta = item.metadata_json as any;
  const aiReplyWorthy = (item.status_json as any)?.ai_reply_worthy;
  const aiSummary = meta?.ai_summary;
  const displayBody = displayBodyFor(item);
  const gist = gistFor(item);
  const showSummaryBox = !!aiSummary && displayBody.length >= LONG_BODY_CHARS;
  const toEmails = Array.isArray(meta?.to_emails) ? (meta.to_emails as string[]) : [];
  const ccEmails = Array.isArray(meta?.cc_emails) ? (meta.cc_emails as string[]) : [];
  const showParticipants = item.channel === "email" && (toEmails.length > 1 || ccEmails.length > 0);

  // PR 2.4 — visibility for Reply / Follow-up buttons.
  const leadUnsubscribed = leadUnsubscribedById.get(item.lead_id) === true;
  const showReply = canShowReply(item, allItems, leadUnsubscribed);
  const followupVis = followupVisibility(item, allItems);
  const showRing = item.id === freshestRingId;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn("group rounded-lg", item.hidden && "opacity-50", showRing && "ring-1 ring-primary/20")}>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <WhoLabel item={item} currentLead={currentLead} />
                  {groupMode && <LeadChip name={item.lead_name} />}
                  <RelTime at={item.occurred_at} />
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
                  <p className={cn("text-sm font-medium text-foreground leading-snug line-clamp-2", item.hidden && "line-through")}>
                    {item.subject}
                  </p>
                )}
                {showParticipants && open && (
                  <div className="text-[11px] text-muted-foreground/80 leading-snug space-y-0.5">
                    {toEmails.length > 1 && (
                      <p className="truncate"><span className="font-medium">To:</span> {toEmails.join(", ")}</p>
                    )}
                    {ccEmails.length > 0 && (
                      <p className="truncate"><span className="font-medium">Cc:</span> {ccEmails.join(", ")}</p>
                    )}
                  </div>
                )}
                {!open && gist && (
                  <p className="text-[13px] text-muted-foreground line-clamp-1 leading-relaxed">
                    {gist}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 pt-1">
                {showReply && <ReplyButton item={item} actions={actions} />}
                {followupVis !== "never" && (
                  <FollowupButton item={item} visibility={followupVis} actions={actions} />
                )}
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
            {showSummaryBox && (
              <div className="bg-accent/50 rounded-md px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground mb-1">AI Summary</p>
                <SummaryBody
                  text={aiSummary}
                  textClassName="text-[13px] text-foreground leading-relaxed"
                />
              </div>
            )}
            {displayBody ? (
              <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {displayBody}
              </p>
            ) : aiSummary ? (
              <SummaryBody
                text={aiSummary}
                textClassName="text-[13px] text-muted-foreground leading-relaxed"
              />
            ) : null}
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
function ThreadEntry({
  thread,
  defaultOpen,
  onToggleHide,
  allItems,
  leadUnsubscribedById,
  groupMode,
  actions,
  freshestRingId,
  currentLead,
}: {
  thread: ThreadGroup;
  defaultOpen: boolean;
  onToggleHide: (id: string, hidden: boolean) => void;
  allItems: TimelineItem[];
  leadUnsubscribedById: Map<string, boolean>;
  groupMode: boolean;
  actions: RowActions;
  freshestRingId: string | null;
  currentLead?: TimelineMinimalLead | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const latest = thread.latest;
  const tags = useMemo(() => getSignalTags(latest), [latest]);
  const meta = latest.metadata_json as any;
  const aiReplyWorthy = (latest.status_json as any)?.ai_reply_worthy;
  const aiSummary = meta?.ai_summary;
  const displayBody = displayBodyFor(latest);
  const gist = gistFor(latest);
  const showSummaryBox = !!aiSummary && displayBody.length >= LONG_BODY_CHARS;
  const toEmails = Array.isArray(meta?.to_emails) ? (meta.to_emails as string[]) : [];
  const ccEmails = Array.isArray(meta?.cc_emails) ? (meta.cc_emails as string[]) : [];
  const showParticipants = latest.channel === "email" && (toEmails.length > 1 || ccEmails.length > 0);

  // PR 2.4 — Reply / Follow-up visibility for the latest item.
  const latestUnsubscribed = leadUnsubscribedById.get(latest.lead_id) === true;
  const latestShowReply = canShowReply(latest, allItems, latestUnsubscribed);
  const latestFollowupVis = followupVisibility(latest, allItems);
  const latestShowRing = latest.id === freshestRingId;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn("group rounded-lg", latest.hidden && "opacity-50", latestShowRing && "ring-1 ring-primary/20")}>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <WhoLabel item={latest} currentLead={currentLead} />
                  {groupMode && <LeadChip name={latest.lead_name} />}
                  <RelTime at={latest.occurred_at} />
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
                  <p className={cn("text-sm font-medium text-foreground leading-snug line-clamp-2", latest.hidden && "line-through")}>
                    {latest.subject}
                  </p>
                )}
                {showParticipants && open && (
                  <div className="text-[11px] text-muted-foreground/80 leading-snug space-y-0.5">
                    {toEmails.length > 1 && (
                      <p className="truncate"><span className="font-medium">To:</span> {toEmails.join(", ")}</p>
                    )}
                    {ccEmails.length > 0 && (
                      <p className="truncate"><span className="font-medium">Cc:</span> {ccEmails.join(", ")}</p>
                    )}
                  </div>
                )}
                {!open && gist && (
                  <p className="text-[13px] text-muted-foreground line-clamp-1 leading-relaxed">
                    {gist}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 pt-1">
                {latestShowReply && <ReplyButton item={latest} actions={actions} />}
                {latestFollowupVis !== "never" && (
                  <FollowupButton item={latest} visibility={latestFollowupVis} actions={actions} />
                )}
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
            {showSummaryBox && (
              <div className="bg-accent/50 rounded-md px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground mb-1">AI Summary</p>
                <SummaryBody
                  text={aiSummary}
                  textClassName="text-[13px] text-foreground leading-relaxed"
                />
              </div>
            )}
            {displayBody ? (
              <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed line-clamp-4">
                {displayBody}
              </p>
            ) : aiSummary ? (
              <SummaryBody
                text={aiSummary}
                textClassName="text-[13px] text-muted-foreground leading-relaxed"
              />
            ) : null}
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
                    {thread.items.slice(1).map(msg => {
                      // PR 2.4 — Reply / Follow-up visibility per older message.
                      const msgUnsub = leadUnsubscribedById.get(msg.lead_id) === true;
                      const msgShowReply = canShowReply(msg, allItems, msgUnsub);
                      const msgFollowupVis = followupVisibility(msg, allItems);
                      const msgShowRing = msg.id === freshestRingId;
                      return (
                        <div
                          key={msg.id}
                          className={cn(
                            "space-y-0.5 group/msg rounded-md",
                            msg.hidden && "opacity-50",
                            msgShowRing && "ring-1 ring-primary/20 p-1",
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <WhoLabel item={msg} currentLead={currentLead} />
                            {groupMode && <LeadChip name={msg.lead_name} />}
                            <RelTime at={msg.occurred_at} />
                            <div className="flex-1" />
                            {msgShowReply && <ReplyButton item={msg} actions={actions} />}
                            {msgFollowupVis !== "never" && (
                              <FollowupButton item={msg} visibility={msgFollowupVis} actions={actions} />
                            )}
                            <HideButton itemId={msg.id} isHidden={msg.hidden} onToggle={onToggleHide} />
                          </div>
                          <p className={cn("text-[13px] text-muted-foreground line-clamp-3 leading-relaxed", msg.hidden && "line-through")}>
                            {displayBodyFor(msg)}
                          </p>
                        </div>
                      );
                    })}
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
                  <RelTime at={item.occurred_at} />
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
            {aiSummary ? (
              <p className="text-[13px] text-foreground whitespace-pre-wrap leading-relaxed">{aiSummary}</p>
            ) : item.snippet_text ? (
              <p className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {item.snippet_text}
              </p>
            ) : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/* ── WhatsApp Entry ── */
function WhatsAppEntry({ item, onToggleHide, currentLead }: { item: TimelineItem; onToggleHide: (id: string, hidden: boolean) => void; currentLead?: TimelineMinimalLead | null }) {
  const isOutbound = item.direction === "outbound";
  return (
    <div className={cn("py-3 px-3 -mx-3 group", isOutbound ? "flex justify-end" : "flex justify-start", item.hidden && "opacity-50")}>
      <div className={cn(
        "max-w-[80%] rounded-2xl px-4 py-2.5 space-y-1",
        isOutbound ? "bg-primary/10 rounded-br-md" : "bg-accent rounded-bl-md"
      )}>
        <div className="flex items-center gap-2">
          <WhoLabel item={item} currentLead={currentLead} />
          <RelTime at={item.occurred_at} />
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
  const [open, setOpen] = useState(false);
  const [callDetail, setCallDetail] = useState<{ summaryLong: string | null; transcript: string | null } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const meta = item.metadata_json as any;
  const duration = meta?.duration_sec;
  const summary = meta?.summary_short;
  const callSessionId = meta?.call_session_id;

  const loadCallDetail = useCallback(async () => {
    if (callDetail || !callSessionId) return;
    setLoadingDetail(true);
    try {
      const [analysisRes, transcriptRes] = await Promise.all([
        supabase.from("call_analyses").select("summary_long").eq("call_session_id", callSessionId).maybeSingle(),
        supabase.from("call_transcripts").select("llm_formatted_text, full_text, clean_full_text").eq("call_session_id", callSessionId).maybeSingle(),
      ]);
      setCallDetail({
        summaryLong: analysisRes.data?.summary_long || null,
        transcript: transcriptRes.data?.llm_formatted_text || transcriptRes.data?.full_text || transcriptRes.data?.clean_full_text || null,
      });
    } catch (err) {
      console.error("Failed to load call detail:", err);
    } finally {
      setLoadingDetail(false);
    }
  }, [callSessionId, callDetail]);

  const handleToggle = (val: boolean) => {
    setOpen(val);
    if (val) loadCallDetail();
  };

  const downloadTranscript = () => {
    if (!callDetail?.transcript) return;
    const dateStr = format(new Date(item.occurred_at), "yyyy-MM-dd_HHmm");
    const blob = new Blob([callDetail.transcript], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `call-transcript_${dateStr}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Collapsible open={open} onOpenChange={handleToggle}>
      <div className={cn("group", item.hidden && "opacity-50")}>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <ChannelBadge item={item} />
                  <RelTime at={item.occurred_at} />
                  {duration && (
                    <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full border border-border">
                      {Math.round(duration / 60)}m {duration % 60}s
                    </span>
                  )}
                </div>
                {item.subject && <p className="text-sm font-medium text-foreground">{item.subject}</p>}
                {!open && (summary || item.snippet_text) && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2">{summary || item.snippet_text}</p>
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
          <div className="pl-3 pb-3 space-y-3">
            {/* Full summary */}
            {loadingDetail && (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-2">
                <div className="h-3 w-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
                Loading call details…
              </div>
            )}
            {callDetail?.summaryLong && (
              <div className="bg-accent/50 rounded-md px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground mb-1">Full Summary</p>
                <p className="text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">{callDetail.summaryLong}</p>
              </div>
            )}
            {!callDetail?.summaryLong && !loadingDetail && (summary || item.snippet_text) && (
              <p className="text-[13px] text-muted-foreground leading-relaxed">{summary || item.snippet_text}</p>
            )}

            {/* Transcript */}
            {callDetail?.transcript && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                    <FileText className="h-3 w-3" /> Transcript
                  </p>
                  <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1 px-2" onClick={downloadTranscript}>
                    <Download className="h-3 w-3" /> Download
                  </Button>
                </div>
                <pre className="text-[12px] text-muted-foreground whitespace-pre-wrap break-words max-h-64 overflow-y-auto bg-muted/30 rounded-lg p-3 font-mono leading-relaxed border border-border">
                  {callDetail.transcript}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/* ── Main Component ── */
export default function TimelineTab({ leadId, onWhatsAppReply, groupId, currentLead }: TimelineTabProps) {
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isSavingReply, setIsSavingReply] = useState(false);
  const [activeFilter, setActiveFilter] = useState<TimelineFilter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  // PR 2.4 — group members lookup (id → MinimalLead). Empty in solo mode.
  const [groupMembers, setGroupMembers] = useState<Map<string, TimelineMinimalLead>>(new Map());
  // PR 2.4 — EmailActionDialog reply target state.
  const [replyTarget, setReplyTarget] = useState<TimelineItem | null>(null);
  const [replyContext, setReplyContext] = useState<"reply" | "follow_up">("reply");
  const [replyTargetLead, setReplyTargetLead] = useState<TimelineMinimalLead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const groupMode = !!groupId;

  const loadTimeline = () => {
    setIsLoading(true);
    const reader = groupId
      ? getGroupTimelineItems(groupId, { includeHidden: showHidden })
      : getLeadTimeline(leadId, { includeHidden: showHidden });
    reader
      .then(items => setTimelineItems(items))
      .catch(console.error)
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    loadTimeline();
  }, [leadId, groupId, showHidden]);

  // Live-refresh the timeline when a new event lands for this lead.
  // Group mode also receives updates for the current lead only — group
  // members are loaded separately and a full re-fetch would thrash.
  useRealtimeSubscription(
    {
      table: "lead_timeline_items",
      filter: `lead_id=eq.${leadId}`,
      enabled: !!leadId,
    },
    () => {
      loadTimeline();
    }
  );

  // PR 2.4 — load all group members up front so the Reply/Follow-up dialog
  // can resolve the right lead per row (and the unsubscribed gate can use
  // the row's lead, not just the page's currentLead).
  useEffect(() => {
    if (!groupId) {
      setGroupMembers(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("id, name, email, company, stage, motion, job_title, unsubscribed")
        .eq("group_id", groupId);
      if (cancelled || error) return;
      const map = new Map<string, TimelineMinimalLead>();
      for (const l of (data ?? []) as any[]) {
        map.set(l.id, {
          id: l.id, name: l.name, email: l.email ?? "",
          company: l.company ?? "", stage: l.stage ?? "new",
          motion: l.motion ?? undefined, job_title: l.job_title ?? null,
          unsubscribed: l.unsubscribed === true,
        });
      }
      setGroupMembers(map);
    })();
    return () => { cancelled = true; };
  }, [groupId]);

  // PR 2.4 — unsubscribed gate map (across solo + group views).
  const leadUnsubscribedById = useMemo(() => {
    const m = new Map<string, boolean>();
    if (currentLead) m.set(currentLead.id, currentLead.unsubscribed === true);
    for (const [id, lead] of groupMembers) m.set(id, lead.unsubscribed === true);
    return m;
  }, [currentLead, groupMembers]);

  // PR 2.4 — resolve which lead to attach to a clicked timeline row.
  // Strict: an unrecognized row.lead_id must NOT silently fall back to
  // currentLead — in group mode that would mis-attribute outbound/draft/state
  // writes to the page's lead instead of the row's owner while groupMembers
  // is still loading.
  const leadForRow = useCallback((row: TimelineItem): TimelineMinimalLead | null => {
    if (groupMembers.has(row.lead_id)) return groupMembers.get(row.lead_id) ?? null;
    if (currentLead && row.lead_id === currentLead.id) return currentLead;
    return null;
  }, [groupMembers, currentLead]);

  // PR 2.4 follow-up — id of the freshest unreplied inbound row that's
  // also <6h old. Renders a static ring (no animation) on that one row to
  // call attention without screaming. null = no ring anywhere. Recomputes
  // when the timeline reloads — there's no per-tick render loop.
  const freshestRingId = useMemo<string | null>(() => {
    const candidates = timelineItems.filter(i => {
      if (i.event_type !== "email_inbound") return false;
      const unsub = leadUnsubscribedById.get(i.lead_id) === true;
      if (!canShowReply(i, timelineItems, unsub)) return false;
      const ageHours = (Date.now() - new Date(i.occurred_at).getTime()) / 3_600_000;
      return ageHours < FRESH_INBOUND_RING_HOURS;
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
    return candidates[0].id;
  }, [timelineItems, leadUnsubscribedById]);

  // PR 2.4 — open EmailActionDialog targeting a specific row.
  const openDialog = useCallback((item: TimelineItem, ctx: "reply" | "follow_up") => {
    const targetLead = leadForRow(item);
    if (!targetLead) {
      toast.error("Couldn't resolve the lead for that row.");
      return;
    }
    setReplyTarget(item);
    setReplyTargetLead(targetLead);
    setReplyContext(ctx);
    setDialogOpen(true);
  }, [leadForRow]);

  const handleSnoozeFollowup = useCallback(async (item: TimelineItem, days: number) => {
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    try {
      await setTimelineFollowupState(item.id, { snoozedUntil: until });
      toast.success(`Snoozed for ${days} day${days > 1 ? "s" : ""}`);
      loadTimeline();
    } catch (err) {
      console.error("[TimelineTab] Snooze failed:", err);
      toast.error("Failed to snooze");
    }
  }, []);

  const handleDismissFollowup = useCallback(async (item: TimelineItem) => {
    const previous = item.followup_dismissed_at;
    const now = new Date().toISOString();
    try {
      await setTimelineFollowupState(item.id, { dismissedAt: now });
      // Optimistic local update (avoid full reload during the 5-second undo window)
      setTimelineItems(prev => prev.map(r => r.id === item.id ? { ...r, followup_dismissed_at: now } : r));
      toast.success("Dismissed", {
        duration: 5000,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await setTimelineFollowupState(item.id, { clearDismissed: true });
              setTimelineItems(prev => prev.map(r => r.id === item.id ? { ...r, followup_dismissed_at: previous ?? null } : r));
              toast.success("Undone");
            } catch (err) {
              console.error("[TimelineTab] Undo dismiss failed:", err);
              toast.error("Undo failed");
            }
          },
        },
      });
    } catch (err) {
      console.error("[TimelineTab] Dismiss failed:", err);
      toast.error("Failed to dismiss");
    }
  }, []);

  const rowActions: RowActions = useMemo(() => ({
    onReply: (item) => openDialog(item, "reply"),
    onFollowup: (item) => openDialog(item, "follow_up"),
    onSnoozeRow: handleSnoozeFollowup,
    onDismissRow: handleDismissFollowup,
  }), [openDialog, handleSnoozeFollowup, handleDismissFollowup]);

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
      // Canonical write: insertInteraction projects to lead_timeline_items AND
      // mirrors to legacy interactions in one shared helper. No more inline
      // dual-write here.
      const occurredAt = new Date().toISOString();
      await insertInteraction(leadId, {
        type: "whatsapp_inbound",
        source: "manual",
        body_text: replyText.trim(),
        direction: "inbound",
        channel: "whatsapp",
        occurred_at: occurredAt,
      });

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
    const base = activeFilter === "all"
      ? timelineItems
      : timelineItems.filter(i => matchesFilter(i, activeFilter));
    // Hide bare system_note rows (no subject AND no displayable snippet) —
    // they render as a date pill with no content and look broken.
    return base.filter(i => {
      if (i.event_type !== "system_note") return true;
      const hasSubject = !!(i.subject && i.subject.trim());
      const hasSnippet = !!(i.snippet_text && formatSnippet(i).trim());
      return hasSubject || hasSnippet;
    });
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
      {/* Filter bar — "All" by default + a single Filter affordance */}
      <div className="flex items-center gap-2 pb-3">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 flex-wrap">
          <button
            onClick={() => setActiveFilter("all")}
            className={cn(
              "text-[12px] font-medium px-3 py-1 rounded-full border transition-colors",
              activeFilter === "all"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted/50 text-muted-foreground border-border hover:bg-accent hover:text-foreground"
            )}
          >
            All
          </button>

          {activeFilter !== "all" && (
            <button
              onClick={() => setActiveFilter("all")}
              className="inline-flex items-center gap-1 text-[12px] font-medium px-3 py-1 rounded-full border bg-primary text-primary-foreground border-primary"
              title="Clear filter"
            >
              {FILTER_OPTIONS.find(o => o.value === activeFilter)?.label}
              <X className="h-3 w-3" />
            </button>
          )}

          <Popover open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
            <PopoverTrigger asChild>
              <button
                className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-1 rounded-full border bg-muted/50 text-muted-foreground border-border hover:bg-accent hover:text-foreground transition-colors"
                title="Filter the timeline"
              >
                <SlidersHorizontal className="h-3 w-3" />
                Filter
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-44 p-1">
              {FILTER_OPTIONS.filter(o => o.value !== "all").map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setActiveFilter(opt.value); setFilterMenuOpen(false); }}
                  className={cn(
                    "w-full text-left px-2 py-1.5 text-xs rounded hover:bg-accent",
                    activeFilter === opt.value && "bg-accent font-medium"
                  )}
                >
                  {opt.label}
                </button>
              ))}
              <div className="my-1 border-t border-border" />
              <button
                onClick={() => { setShowHidden(!showHidden); setFilterMenuOpen(false); }}
                className="w-full flex items-center gap-1.5 text-left px-2 py-1.5 text-xs rounded hover:bg-accent"
              >
                {showHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                {showHidden ? "Hide hidden items" : `Show hidden${hiddenCount > 0 ? ` (${hiddenCount})` : ""}`}
              </button>
            </PopoverContent>
          </Popover>

          {showHidden && (
            <span className="text-[11px] text-muted-foreground">Showing hidden</span>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="text-xs shrink-0"
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
                <ThreadEntry
                  thread={entry}
                  defaultOpen={isExpanded}
                  onToggleHide={handleToggleHide}
                  allItems={timelineItems}
                  leadUnsubscribedById={leadUnsubscribedById}
                  groupMode={groupMode}
                  actions={rowActions}
                  freshestRingId={freshestRingId}
                  currentLead={currentLead}
                />
              ) : entry.channel === "meeting" ? (
                <MeetingEntry item={entry} defaultOpen={isExpanded} onToggleHide={handleToggleHide} />
              ) : entry.channel === "whatsapp" ? (
                <WhatsAppEntry item={entry} onToggleHide={handleToggleHide} currentLead={currentLead} />
              ) : entry.channel === "voice" ? (
                <CallEntry item={entry} onToggleHide={handleToggleHide} />
              ) : (
                <TimelineEntry
                  item={entry}
                  defaultOpen={isExpanded}
                  onToggleHide={handleToggleHide}
                  showHidden={showHidden}
                  allItems={timelineItems}
                  leadUnsubscribedById={leadUnsubscribedById}
                  groupMode={groupMode}
                  actions={rowActions}
                  freshestRingId={freshestRingId}
                  currentLead={currentLead}
                />
              )}
            </div>
          );
        })
      )}

      {/* PR 2.4 — Reply / Follow-up composer */}
      {replyTargetLead && replyTarget && (
        <EmailActionDialog
          lead={replyTargetLead}
          open={dialogOpen}
          onOpenChange={(o) => {
            setDialogOpen(o);
            if (!o) {
              setReplyTarget(null);
              setReplyTargetLead(null);
              loadTimeline();
            }
          }}
          replyToTimelineItem={replyTarget}
          replyContext={replyContext}
        />
      )}
    </div>
  );
}
