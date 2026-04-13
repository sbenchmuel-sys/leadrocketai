import { supabase } from "@/integrations/supabase/client";
import { providerToCanonical, type CanonicalChannel } from "@/lib/channels";
import type { QuickChip, InboxSort, WaitingOn } from "@/lib/inboxStateCache";

// ── Types ──────────────────────────────────────────────────────────────

export type ConversationListItem = {
  id: string;            // lead_id — one "conversation" per lead
  contact_id: string;    // kept for compat — same as lead_id
  contact_name: string;
  contact_company: string | null;
  contact_status: string;
  channel: string;       // canonical channel of latest message
  status: string;
  last_message_at: string;
  message_count: number;
  latest_summary: string | null;
  latest_sentiment: string | null;
  unread: boolean;
  lead_id: string;
  latest_snippet: string | null;
  latest_direction: string | null;
  channels_used: string[];
};

export type TimelineMessage = {
  id: string;
  direction: "inbound" | "outbound" | null;
  body_text: string | null;
  channel: string;
  provider: string | null;
  event_type: string;
  created_at: string;
  subject: string | null;
  status: string;
  source_table: string;
};

export type DecryptedMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body_text: string | null;
  is_expired: boolean;
  media_type: string | null;
  created_at: string;
  sender_identity_id: string | null;
  status: "sent" | "delivered" | "read" | "failed";
};

export type ConversationAnalysis = {
  summary_short: string | null;
  summary_text: string | null;
  sentiment: string | null;
  urgency: string | null;
  topics: string[] | null;
  extracted_features: Record<string, any>;
  recommended_reply_channel: string | null;
};

export type ReplySuggestion = {
  style: string;
  text: string;
};

// ── Filters ────────────────────────────────────────────────────────────

export interface InboxFilters {
  tab: "active" | "new" | "archived";
  search?: string;
  channelFilter?: CanonicalChannel[];
  quickChip?: QuickChip;
  sortBy?: InboxSort;
  revenueState?: string | null;
  waitingOn?: WaitingOn;
}

/**
 * Fetch inbox items — one row per lead, sourced from lead_timeline_items + leads.
 * Groups by lead and picks the latest timeline entry for display.
 */
export async function fetchConversations(
  filterOrTab: InboxFilters | "active" | "new" | "archived"
): Promise<ConversationListItem[]> {
  const filters: InboxFilters = typeof filterOrTab === "string"
    ? { tab: filterOrTab }
    : filterOrTab;

  const { tab, search, channelFilter, sortBy = "recent" } = filters;

  // Step 1: Fetch leads (the "conversation" unit)
  let leadsQuery = supabase
    .from("leads")
    .select("id, name, company, email, status, stage, last_activity_at, phone");

  // Tab filter
  if (tab === "new") {
    leadsQuery = leadsQuery.eq("stage", "new");
  } else if (tab === "archived") {
    leadsQuery = leadsQuery.in("status", ["lost", "unresponsive", "disqualified"]);
  } else {
    // active — not new and not lost
    leadsQuery = leadsQuery.neq("stage", "new").not("status", "in", '("lost","unresponsive","disqualified")');
  }

  if (search && search.trim().length >= 2) {
    const term = `%${search.trim()}%`;
    leadsQuery = leadsQuery.or(`name.ilike.${term},company.ilike.${term},email.ilike.${term}`);
  }

  // Sort
  if (sortBy === "stale") {
    leadsQuery = leadsQuery.order("last_activity_at", { ascending: true });
  } else {
    leadsQuery = leadsQuery.order("last_activity_at", { ascending: false });
  }

  leadsQuery = leadsQuery.limit(100);

  const { data: leads, error: leadsErr } = await leadsQuery;
  if (leadsErr) throw leadsErr;
  if (!leads?.length) return [];

  const leadIds = leads.map((l) => l.id);

  // Step 2: Get latest timeline item per lead + aggregate counts
  // We use a single query with ordering and then group client-side
  const { data: timelineItems, error: tlErr } = await supabase
    .from("lead_timeline_items")
    .select("lead_id, channel, direction, event_type, snippet_text, subject, occurred_at, source_table")
    .in("lead_id", leadIds)
    .eq("hidden", false)
    .order("occurred_at", { ascending: false })
    .limit(1000);

  if (tlErr) throw tlErr;

  // Group timeline data by lead
  const leadTimeline = new Map<string, {
    latest: typeof timelineItems[0] | null;
    count: number;
    channels: Set<string>;
    hasInbound: boolean;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
  }>();

  for (const item of (timelineItems ?? [])) {
    let entry = leadTimeline.get(item.lead_id);
    if (!entry) {
      entry = { latest: null, count: 0, channels: new Set(), hasInbound: false, lastInboundAt: null, lastOutboundAt: null };
      leadTimeline.set(item.lead_id, entry);
    }
    if (!entry.latest) entry.latest = item;
    entry.count++;
    if (item.channel) entry.channels.add(item.channel);
    if (item.direction === "inbound") {
      entry.hasInbound = true;
      if (!entry.lastInboundAt) entry.lastInboundAt = item.occurred_at;
    }
    if (item.direction === "outbound") {
      if (!entry.lastOutboundAt) entry.lastOutboundAt = item.occurred_at;
    }
  }

  // Build list items
  let items: ConversationListItem[] = leads.map((lead) => {
    const tl = leadTimeline.get(lead.id);
    const latest = tl?.latest;
    const isUnread = tl?.lastInboundAt && tl?.lastOutboundAt
      ? new Date(tl.lastInboundAt) > new Date(tl.lastOutboundAt)
      : !!tl?.hasInbound;

    return {
      id: lead.id,
      contact_id: lead.id,
      contact_name: lead.name,
      contact_company: lead.company,
      contact_status: lead.stage ?? lead.status,
      channel: latest?.channel ?? "email",
      status: lead.status === "lost" ? "closed" : "open",
      last_message_at: latest?.occurred_at ?? lead.last_activity_at,
      message_count: tl?.count ?? 0,
      latest_summary: null,
      latest_sentiment: null,
      unread: isUnread,
      lead_id: lead.id,
      latest_snippet: latest?.snippet_text ?? null,
      latest_direction: latest?.direction ?? null,
      channels_used: Array.from(tl?.channels ?? []),
    };
  });

  // Filter out leads with no timeline items in active/archived tabs
  if (tab !== "new") {
    items = items.filter((item) => item.message_count > 0);
  }

  // Client-side channel filter
  if (channelFilter && channelFilter.length > 0) {
    items = items.filter((item) => {
      return item.channels_used.some((ch) => channelFilter.includes(ch as CanonicalChannel));
    });
  }

  // Client-side quick chip filters
  if (filters.quickChip) {
    items = applyQuickChipFilter(items, filters.quickChip);
  }

  // Urgent sort
  if (sortBy === "urgent") {
    items.sort((a, b) => {
      const score = (i: ConversationListItem) => (i.unread ? 2 : 0) + (i.message_count > 5 ? 1 : 0);
      return score(b) - score(a);
    });
  }

  return items;
}

function applyQuickChipFilter(items: ConversationListItem[], chip: QuickChip): ConversationListItem[] {
  switch (chip) {
    case "needs_action":
      return items.filter((c) => c.unread);
    case "new_inbound":
      return items.filter((c) => c.latest_direction === "inbound");
    case "unreplied":
      return items.filter((c) => c.unread);
    case "hot":
      return items.filter((c) => c.message_count >= 5);
    case "overdue":
      return items.filter((c) => {
        if (!c.last_message_at) return false;
        const diffMs = Date.now() - new Date(c.last_message_at).getTime();
        return diffMs > 48 * 60 * 60 * 1000;
      });
    default:
      return items;
  }
}

// ── Thread messages — from interactions + timeline ─────────────────────

export async function fetchDecryptedMessages(
  leadId: string
): Promise<{ messages: DecryptedMessage[]; analysis: ConversationAnalysis | null }> {
  // Fetch interactions for this lead (the actual message content)
  const { data: interactions, error } = await supabase
    .from("interactions")
    .select("id, direction, body_text, type, source, subject, occurred_at, hidden")
    .eq("lead_id", leadId)
    .eq("hidden", false)
    .order("occurred_at", { ascending: true })
    .limit(200);

  if (error) throw error;

  const messages: DecryptedMessage[] = (interactions ?? []).map((i) => ({
    id: i.id,
    direction: (i.direction as "inbound" | "outbound") ?? "outbound",
    body_text: i.body_text,
    is_expired: false,
    media_type: null,
    created_at: i.occurred_at,
    sender_identity_id: null,
    status: "delivered" as const,
  }));

  // Also fetch SMS/WhatsApp messages from the messages table via timeline
  const { data: timelineItems } = await supabase
    .from("lead_timeline_items")
    .select("id, direction, snippet_text, channel, occurred_at, event_type, source_table, source_id, subject")
    .eq("lead_id", leadId)
    .eq("hidden", false)
    .in("channel", ["sms", "whatsapp", "voice"])
    .order("occurred_at", { ascending: true })
    .limit(200);

  for (const tl of (timelineItems ?? [])) {
    // Avoid duplicates with interactions
    messages.push({
      id: tl.id,
      direction: (tl.direction as "inbound" | "outbound") ?? "outbound",
      body_text: tl.snippet_text ?? `[${tl.event_type}]`,
      is_expired: false,
      media_type: tl.channel === "voice" ? "voice" : null,
      created_at: tl.occurred_at,
      sender_identity_id: null,
      status: "delivered",
    });
  }

  // Sort all messages chronologically
  messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return { messages, analysis: null };
}

export async function fetchContactAnalysis(
  contactOrLeadId: string
): Promise<ConversationAnalysis | null> {
  // Try lead intelligence first (canonical source)
  const { data: intel } = await supabase
    .from("lead_intelligence")
    .select("summary_text, channel_recommendations_json")
    .eq("lead_id", contactOrLeadId)
    .maybeSingle();

  if (intel) {
    return {
      summary_short: intel.summary_text?.substring(0, 100) ?? null,
      summary_text: intel.summary_text,
      sentiment: null,
      urgency: null,
      topics: null,
      extracted_features: {},
      recommended_reply_channel: null,
    };
  }

  // Fallback to conversation_analysis
  const { data, error } = await supabase
    .from("conversation_analysis")
    .select("summary_short, summary_text, sentiment, urgency, topics, extracted_features, recommended_reply_channel")
    .eq("contact_id", contactOrLeadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as ConversationAnalysis;
}

export async function fetchAllContactAnalysis(
  contactOrLeadId: string
): Promise<ConversationAnalysis[]> {
  const { data, error } = await supabase
    .from("conversation_analysis")
    .select("summary_short, summary_text, sentiment, urgency, topics, extracted_features, recommended_reply_channel")
    .eq("contact_id", contactOrLeadId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) return [];
  return (data ?? []) as ConversationAnalysis[];
}
