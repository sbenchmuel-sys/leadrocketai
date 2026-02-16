import { supabase } from "@/integrations/supabase/client";

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
};

export type DecryptedMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body_text: string | null;
  is_expired: boolean;
  media_type: string | null;
  created_at: string;
  sender_identity_id: string | null;
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

export async function fetchConversations(
  filter: "active" | "new" | "archived"
): Promise<ConversationListItem[]> {
  // Use the manager view for enriched data
  let query = supabase
    .from("manager_conversation_metrics")
    .select("*")
    .order("last_message_at", { ascending: false });

  if (filter === "new") {
    query = query.eq("contact_status", "unclassified");
  } else if (filter === "archived") {
    query = query.eq("status", "closed");
  } else {
    query = query.neq("status", "closed").neq("contact_status", "unclassified");
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((row) => ({
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
  }));
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
