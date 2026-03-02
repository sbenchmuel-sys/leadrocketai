import { supabase } from "@/integrations/supabase/client";
import { providerToCanonical, type CanonicalChannel } from "@/lib/channels";
import type { QuickChip, InboxSort, WaitingOn } from "@/lib/inboxStateCache";

export type ConversationListItem = {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_company: string | null;
  contact_status: string;
  channel: "gmail" | "whatsapp";
  status: string;
  last_message_at: string;
  message_count: number;
  latest_summary: string | null;
  latest_sentiment: string | null;
  unread: boolean; // inbound after last outbound
  lead_id: string | null;
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

export async function fetchConversations(
  filterOrTab: InboxFilters | "active" | "new" | "archived"
): Promise<ConversationListItem[]> {
  // Support legacy simple string argument
  const filters: InboxFilters = typeof filterOrTab === "string"
    ? { tab: filterOrTab }
    : filterOrTab;

  const { tab, search, channelFilter, sortBy = "recent" } = filters;

  // Use the manager view for enriched data
  let query = supabase
    .from("manager_conversation_metrics")
    .select("*");

  // Sort server-side
  if (sortBy === "stale") {
    query = query.order("last_message_at", { ascending: true });
  } else {
    // recent, urgent, new_inbound all use desc last_message_at as base sort
    query = query.order("last_message_at", { ascending: false });
  }

  // Tab filter
  if (tab === "new") {
    query = query.eq("contact_status", "unclassified");
  } else if (tab === "archived") {
    query = query.eq("status", "closed");
  } else {
    query = query.neq("status", "closed").neq("contact_status", "unclassified");
  }

  // Server-side search (ilike on contact name/company)
  if (search && search.trim().length >= 2) {
    const term = `%${search.trim()}%`;
    query = query.or(`contact_name.ilike.${term},contact_company.ilike.${term}`);
  }

  // Server-side channel filter
  if (channelFilter && channelFilter.length > 0) {
    // Map canonical channels back to provider channels stored in DB
    const providerChannels: string[] = [];
    for (const ch of channelFilter) {
      if (ch === "email") { providerChannels.push("gmail", "outlook"); }
      else { providerChannels.push(ch); }
    }
    query = query.in("channel", providerChannels);
  }

  // Limit for performance
  query = query.limit(200);

  const { data, error } = await query;
  if (error) throw error;

  let items: ConversationListItem[] = (data ?? []).map((row) => ({
    id: row.conversation_id!,
    contact_id: row.contact_id!,
    contact_name: row.contact_name ?? "Unknown",
    contact_company: row.contact_company,
    contact_status: row.contact_status ?? "unclassified",
    channel: row.channel as "gmail" | "whatsapp",
    status: row.status ?? "open",
    last_message_at: row.last_message_at ?? "",
    message_count: row.message_count ?? 0,
    latest_summary: row.latest_summary,
    latest_sentiment: row.latest_sentiment,
    unread: false, // TODO: compute from last seen
    lead_id: (row as any).lead_id ?? null,
  }));

  // Client-side quick chip filters (data not always available server-side)
  if (filters.quickChip) {
    items = applyQuickChipFilter(items, filters.quickChip);
  }

  // Client-side sentiment filter for "hot" sort
  if (sortBy === "urgent") {
    // Negative/urgent sentiment first
    items.sort((a, b) => {
      const urgencyScore = (s: string | null) => {
        if (!s) return 0;
        const sl = s.toLowerCase();
        if (sl === "negative" || sl === "frustrated") return 3;
        if (sl === "neutral") return 1;
        return 0;
      };
      return urgencyScore(b.latest_sentiment) - urgencyScore(a.latest_sentiment);
    });
  }

  return items;
}

function applyQuickChipFilter(items: ConversationListItem[], chip: QuickChip): ConversationListItem[] {
  switch (chip) {
    case "needs_action":
      // Conversations with unread inbound (approximation: unread flag or contact_status indicators)
      // TODO: extend server view to include lead.needs_action
      return items.filter((c) => c.unread || c.contact_status === "unclassified");
    case "new_inbound":
      return items.filter((c) => c.contact_status === "unclassified");
    case "unreplied":
      // Conversations where latest message was inbound (no outbound reply yet)
      // Best-effort: low message count + unread
      return items.filter((c) => c.unread);
    case "hot":
      return items.filter((c) => {
        const s = c.latest_sentiment?.toLowerCase();
        return s === "positive" || s === "interested" || s === "excited";
      });
    case "overdue":
      // Conversations with no activity in 48h+
      return items.filter((c) => {
        if (!c.last_message_at) return false;
        const diffMs = Date.now() - new Date(c.last_message_at).getTime();
        return diffMs > 48 * 60 * 60 * 1000;
      });
    default:
      return items;
  }
}

export async function fetchDecryptedMessages(
  conversationId: string
): Promise<{ messages: DecryptedMessage[]; analysis: ConversationAnalysis | null }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/decrypt-messages?conversation_id=${conversationId}`;
  const fetchResp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
  });

  if (!fetchResp.ok) {
    const errText = await fetchResp.text();
    throw new Error(`Failed to fetch messages: ${errText}`);
  }

  return fetchResp.json();
}

export async function fetchContactAnalysis(
  contactId: string
): Promise<ConversationAnalysis | null> {
  const { data, error } = await supabase
    .from("conversation_analysis")
    .select("summary_short, summary_text, sentiment, urgency, topics, extracted_features, recommended_reply_channel")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as ConversationAnalysis;
}

export async function fetchAllContactAnalysis(
  contactId: string
): Promise<ConversationAnalysis[]> {
  const { data, error } = await supabase
    .from("conversation_analysis")
    .select("summary_short, summary_text, sentiment, urgency, topics, extracted_features, recommended_reply_channel")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) return [];
  return (data ?? []) as ConversationAnalysis[];
}
