import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Get all workspaces
    const { data: workspaces, error: wsErr } = await supabase
      .from("workspaces")
      .select("id");

    if (wsErr || !workspaces?.length) {
      return new Response(JSON.stringify({ ok: true, computed: 0, reason: "no workspaces" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let computed = 0;

    for (const ws of workspaces) {
      // Get all reps in workspace
      const { data: members } = await supabase
        .from("workspace_members")
        .select("user_id, role")
        .eq("workspace_id", ws.id);

      if (!members?.length) continue;

      const reps = members.filter((m) => m.role === "rep" || m.role === "admin");

      for (const rep of reps) {
        const repMetrics = await computeRepMetrics(supabase, ws.id, rep.user_id);

        // Upsert into manager_views
        const { error: upsertErr } = await supabase
          .from("manager_views")
          .upsert(
            {
              workspace_id: ws.id,
              rep_user_id: rep.user_id,
              computed_at: new Date().toISOString(),
              ...repMetrics,
            },
            { onConflict: "workspace_id,rep_user_id" }
          );

        if (upsertErr) {
          console.error(`[compute-manager-analytics] Upsert failed for rep ${rep.user_id}:`, upsertErr);
        } else {
          computed++;
        }
      }
    }

    console.log(`[compute-manager-analytics] Computed metrics for ${computed} reps`);
    return new Response(
      JSON.stringify({ ok: true, computed }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[compute-manager-analytics] Fatal error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function computeRepMetrics(supabase: any, workspaceId: string, repUserId: string) {
  // 1. Conversations owned by this rep
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, channel, status, last_message_at, message_count, contact_id")
    .eq("workspace_id", workspaceId)
    .eq("owner_user_id", repUserId);

  const convos = conversations ?? [];
  const convoIds = convos.map((c: any) => c.id);

  // 2. Get all analysis records for these conversations (no message body access)
  const { data: analyses } = await supabase
    .from("conversation_analysis")
    .select("conversation_id, contact_id, sentiment, urgency, topics, extracted_features, recommended_reply_channel, summary_short")
    .eq("workspace_id", workspaceId)
    .in("conversation_id", convoIds.length ? convoIds : ["__none__"]);

  const allAnalyses = analyses ?? [];

  // 3. Compute needs-reply: conversations where latest direction is inbound
  // We use message metadata (direction only, no body access)
  let needsReplyCount = 0;
  for (const convo of convos) {
    if (convo.status !== "open") continue;
    const { data: latestMsg } = await supabase
      .from("messages")
      .select("direction")
      .eq("conversation_id", convo.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestMsg?.direction === "inbound") needsReplyCount++;
  }

  // 4. Response time: compute from message timestamps (metadata only)
  const responseTimes: number[] = [];
  for (const convo of convos.slice(0, 20)) {
    // Sample up to 20 convos for performance
    const { data: msgs } = await supabase
      .from("messages")
      .select("direction, created_at")
      .eq("conversation_id", convo.id)
      .order("created_at", { ascending: true })
      .limit(50);

    if (!msgs?.length) continue;

    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i - 1].direction === "inbound" && msgs[i].direction === "outbound") {
        const diff = new Date(msgs[i].created_at).getTime() - new Date(msgs[i - 1].created_at).getTime();
        responseTimes.push(diff / (1000 * 60)); // minutes
      }
    }
  }

  const avgResponseTime = responseTimes.length
    ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    : 0;
  const medianResponseTime = responseTimes.length
    ? responseTimes.sort((a, b) => a - b)[Math.floor(responseTimes.length / 2)]
    : 0;

  // 5. Aggregate from analysis records
  const sentimentDist: Record<string, number> = {};
  const urgencyDist: Record<string, number> = {};
  const objectionFreq: Record<string, number> = {};
  const topicCounts: Record<string, number> = {};
  let highGhostRisk = 0;
  let mediumGhostRisk = 0;
  const ghostRiskContacts: Array<{ contact_id: string; summary: string; risk: string }> = [];
  const channelMetrics: Record<string, { sent: number; received: number; conversations: number }> = {};

  for (const a of allAnalyses) {
    // Sentiment
    const s = a.sentiment ?? "neutral";
    sentimentDist[s] = (sentimentDist[s] ?? 0) + 1;

    // Urgency
    const u = a.urgency ?? "medium";
    urgencyDist[u] = (urgencyDist[u] ?? 0) + 1;

    // Objections
    const features = (a.extracted_features ?? {}) as Record<string, any>;
    const objections = features.objections ?? [];
    for (const obj of objections) {
      // Normalize to keyword
      const key = String(obj).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().split(" ").slice(0, 3).join("_");
      if (key) objectionFreq[key] = (objectionFreq[key] ?? 0) + 1;
    }

    // Ghosting risk
    const ghostRisk = features.ghosting_risk ?? "low";
    if (ghostRisk === "high") {
      highGhostRisk++;
      ghostRiskContacts.push({
        contact_id: a.contact_id,
        summary: a.summary_short ?? "",
        risk: "high",
      });
    } else if (ghostRisk === "medium") {
      mediumGhostRisk++;
      if (ghostRiskContacts.length < 10) {
        ghostRiskContacts.push({
          contact_id: a.contact_id,
          summary: a.summary_short ?? "",
          risk: "medium",
        });
      }
    }

    // Topics
    for (const t of a.topics ?? []) {
      topicCounts[t] = (topicCounts[t] ?? 0) + 1;
    }
  }

  // Channel metrics from conversations
  for (const convo of convos) {
    const ch = convo.channel ?? "whatsapp";
    if (!channelMetrics[ch]) {
      channelMetrics[ch] = { sent: 0, received: 0, conversations: 0 };
    }
    channelMetrics[ch].conversations++;
  }

  // Count sent/received per channel from message metadata
  for (const convo of convos) {
    const ch = convo.channel ?? "whatsapp";
    const { data: dirCounts } = await supabase
      .from("messages")
      .select("direction")
      .eq("conversation_id", convo.id);

    if (dirCounts) {
      for (const m of dirCounts) {
        if (m.direction === "outbound") channelMetrics[ch].sent++;
        else channelMetrics[ch].received++;
      }
    }
  }

  // Stage distribution: from analysis deal_stage
  const stageDist: Record<string, number> = {};
  for (const a of allAnalyses) {
    const features = (a.extracted_features ?? {}) as Record<string, any>;
    const stage = features.deal_stage ?? "unknown";
    stageDist[stage] = (stageDist[stage] ?? 0) + 1;
  }

  // Top topics sorted
  const topTopics = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));

  const totalSent = Object.values(channelMetrics).reduce((s, c) => s + c.sent, 0);
  const totalReceived = Object.values(channelMetrics).reduce((s, c) => s + c.received, 0);

  return {
    avg_response_time_minutes: Math.round(avgResponseTime * 10) / 10,
    median_response_time_minutes: Math.round(medianResponseTime * 10) / 10,
    needs_reply_count: needsReplyCount,
    stage_distribution: stageDist,
    objection_frequency: objectionFreq,
    high_ghost_risk_count: highGhostRisk,
    medium_ghost_risk_count: mediumGhostRisk,
    ghost_risk_contacts: ghostRiskContacts,
    channel_metrics: channelMetrics,
    total_conversations: convos.length,
    total_messages_sent: totalSent,
    total_messages_received: totalReceived,
    active_conversations: convos.filter((c: any) => c.status === "open").length,
    sentiment_distribution: sentimentDist,
    urgency_distribution: urgencyDist,
    top_topics: topTopics,
  };
}
