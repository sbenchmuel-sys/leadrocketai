import { supabase } from "@/integrations/supabase/client";

export type ManagerRepMetrics = {
  id: string;
  workspace_id: string;
  rep_user_id: string;
  computed_at: string;
  avg_response_time_minutes: number;
  median_response_time_minutes: number;
  needs_reply_count: number;
  stage_distribution: Record<string, number>;
  objection_frequency: Record<string, number>;
  high_ghost_risk_count: number;
  medium_ghost_risk_count: number;
  ghost_risk_contacts: Array<{ contact_id: string; summary: string; risk: string }>;
  channel_metrics: Record<string, { sent: number; received: number; conversations: number }>;
  total_conversations: number;
  total_messages_sent: number;
  total_messages_received: number;
  active_conversations: number;
  sentiment_distribution: Record<string, number>;
  urgency_distribution: Record<string, number>;
  top_topics: Array<{ topic: string; count: number }>;
};

export async function fetchManagerMetrics(workspaceId: string): Promise<ManagerRepMetrics[]> {
  const { data, error } = await supabase
    .from("manager_views")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("computed_at", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    id: row.id,
    workspace_id: row.workspace_id,
    rep_user_id: row.rep_user_id,
    computed_at: row.computed_at,
    avg_response_time_minutes: row.avg_response_time_minutes ?? 0,
    median_response_time_minutes: row.median_response_time_minutes ?? 0,
    needs_reply_count: row.needs_reply_count ?? 0,
    stage_distribution: (row.stage_distribution ?? {}) as Record<string, number>,
    objection_frequency: (row.objection_frequency ?? {}) as Record<string, number>,
    high_ghost_risk_count: row.high_ghost_risk_count ?? 0,
    medium_ghost_risk_count: row.medium_ghost_risk_count ?? 0,
    ghost_risk_contacts: (row.ghost_risk_contacts ?? []) as any[],
    channel_metrics: (row.channel_metrics ?? {}) as Record<string, any>,
    total_conversations: row.total_conversations ?? 0,
    total_messages_sent: row.total_messages_sent ?? 0,
    total_messages_received: row.total_messages_received ?? 0,
    active_conversations: row.active_conversations ?? 0,
    sentiment_distribution: (row.sentiment_distribution ?? {}) as Record<string, number>,
    urgency_distribution: (row.urgency_distribution ?? {}) as Record<string, number>,
    top_topics: (row.top_topics ?? []) as any[],
  }));
}

export function aggregateTeamMetrics(reps: ManagerRepMetrics[]) {
  const totals = {
    totalNeedsReply: 0,
    totalConversations: 0,
    totalActive: 0,
    totalSent: 0,
    totalReceived: 0,
    totalHighGhostRisk: 0,
    totalMediumGhostRisk: 0,
    avgResponseTime: 0,
    stageDistribution: {} as Record<string, number>,
    objectionFrequency: {} as Record<string, number>,
    channelMetrics: {} as Record<string, { sent: number; received: number; conversations: number }>,
    sentimentDistribution: {} as Record<string, number>,
    allGhostRiskContacts: [] as Array<{ contact_id: string; summary: string; risk: string }>,
    topTopics: [] as Array<{ topic: string; count: number }>,
  };

  const responseTimes: number[] = [];

  for (const rep of reps) {
    totals.totalNeedsReply += rep.needs_reply_count;
    totals.totalConversations += rep.total_conversations;
    totals.totalActive += rep.active_conversations;
    totals.totalSent += rep.total_messages_sent;
    totals.totalReceived += rep.total_messages_received;
    totals.totalHighGhostRisk += rep.high_ghost_risk_count;
    totals.totalMediumGhostRisk += rep.medium_ghost_risk_count;
    if (rep.avg_response_time_minutes > 0) responseTimes.push(rep.avg_response_time_minutes);

    // Merge distributions
    for (const [k, v] of Object.entries(rep.stage_distribution)) {
      totals.stageDistribution[k] = (totals.stageDistribution[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(rep.objection_frequency)) {
      totals.objectionFrequency[k] = (totals.objectionFrequency[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(rep.channel_metrics)) {
      if (!totals.channelMetrics[k]) totals.channelMetrics[k] = { sent: 0, received: 0, conversations: 0 };
      totals.channelMetrics[k].sent += v.sent;
      totals.channelMetrics[k].received += v.received;
      totals.channelMetrics[k].conversations += v.conversations;
    }
    for (const [k, v] of Object.entries(rep.sentiment_distribution)) {
      totals.sentimentDistribution[k] = (totals.sentimentDistribution[k] ?? 0) + v;
    }

    totals.allGhostRiskContacts.push(...rep.ghost_risk_contacts);
  }

  totals.avgResponseTime = responseTimes.length
    ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 10) / 10
    : 0;

  // Aggregate topics
  const topicMap: Record<string, number> = {};
  for (const rep of reps) {
    for (const t of rep.top_topics) {
      topicMap[t.topic] = (topicMap[t.topic] ?? 0) + t.count;
    }
  }
  totals.topTopics = Object.entries(topicMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));

  return totals;
}
