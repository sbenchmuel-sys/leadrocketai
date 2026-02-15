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
      const { data: members } = await supabase
        .from("workspace_members")
        .select("user_id, role")
        .eq("workspace_id", ws.id);

      if (!members?.length) continue;

      const reps = members.filter((m) => m.role === "rep" || m.role === "admin");

      for (const rep of reps) {
        const repMetrics = await computeRepMetrics(supabase, ws.id, rep.user_id);

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

async function computeRepMetrics(supabase: any, _workspaceId: string, repUserId: string) {
  // 1. Get all leads owned by this rep
  const { data: leads } = await supabase
    .from("leads")
    .select("id, stage, status, deal_outlook, last_inbound_at, last_outbound_at, first_outbound_at, name")
    .eq("owner_user_id", repUserId);

  const allLeads = leads ?? [];
  const leadIds = allLeads.map((l: any) => l.id);

  // 2. Get all interactions for these leads
  const { data: interactions } = await supabase
    .from("interactions")
    .select("id, lead_id, type, direction, source, occurred_at")
    .in("lead_id", leadIds.length ? leadIds : ["__none__"])
    .order("occurred_at", { ascending: true });

  const allInteractions = interactions ?? [];

  // 3. Get meeting summaries for this rep
  const { data: meetingSummaries } = await supabase
    .from("meeting_summaries")
    .select("id, lead_id")
    .eq("user_id", repUserId);

  const allMeetings = meetingSummaries ?? [];

  // --- Emails sent / received ---
  let totalSent = 0;
  let totalReceived = 0;
  for (const i of allInteractions) {
    if (i.type === "email_outbound" || i.direction === "outbound") totalSent++;
    else if (i.type === "email_inbound" || i.direction === "inbound") totalReceived++;
  }

  // --- Response time (inbound → next outbound per lead) ---
  const interactionsByLead: Record<string, any[]> = {};
  for (const i of allInteractions) {
    if (!interactionsByLead[i.lead_id]) interactionsByLead[i.lead_id] = [];
    interactionsByLead[i.lead_id].push(i);
  }

  const responseTimes: number[] = [];
  for (const msgs of Object.values(interactionsByLead)) {
    for (let i = 1; i < msgs.length; i++) {
      const prev = msgs[i - 1];
      const curr = msgs[i];
      const prevIsInbound = prev.type === "email_inbound" || prev.direction === "inbound";
      const currIsOutbound = curr.type === "email_outbound" || curr.direction === "outbound";
      if (prevIsInbound && currIsOutbound) {
        const diff = new Date(curr.occurred_at).getTime() - new Date(prev.occurred_at).getTime();
        responseTimes.push(diff / (1000 * 60)); // minutes
      }
    }
  }

  const avgResponseTime = responseTimes.length
    ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    : 0;
  const sortedRT = [...responseTimes].sort((a, b) => a - b);
  const medianResponseTime = sortedRT.length
    ? sortedRT[Math.floor(sortedRT.length / 2)]
    : 0;

  // --- Needs reply: leads where last interaction is inbound and status != closed ---
  let needsReplyCount = 0;
  for (const lead of allLeads) {
    if (lead.status === "closed") continue;
    const leadMsgs = interactionsByLead[lead.id];
    if (!leadMsgs?.length) continue;
    const last = leadMsgs[leadMsgs.length - 1];
    if (last.type === "email_inbound" || last.direction === "inbound") {
      needsReplyCount++;
    }
  }

  // --- Stage distribution ---
  const stageDist: Record<string, number> = {};
  for (const lead of allLeads) {
    const stage = lead.stage ?? "new";
    stageDist[stage] = (stageDist[stage] ?? 0) + 1;
  }

  // --- Channel metrics from interactions.source ---
  const channelMetrics: Record<string, { sent: number; received: number; conversations: number }> = {};
  const channelLeads: Record<string, Set<string>> = {};
  for (const i of allInteractions) {
    const ch = i.source ?? "email";
    if (!channelMetrics[ch]) {
      channelMetrics[ch] = { sent: 0, received: 0, conversations: 0 };
      channelLeads[ch] = new Set();
    }
    channelLeads[ch].add(i.lead_id);
    if (i.type === "email_outbound" || i.direction === "outbound") channelMetrics[ch].sent++;
    else channelMetrics[ch].received++;
  }
  for (const [ch, leads_set] of Object.entries(channelLeads)) {
    channelMetrics[ch].conversations = leads_set.size;
  }

  // --- Ghost risk: leads with last inbound > last outbound and no outbound in 14+ days ---
  const now = Date.now();
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
  let highGhostRisk = 0;
  let mediumGhostRisk = 0;
  const ghostRiskContacts: Array<{ contact_id: string; summary: string; risk: string }> = [];

  for (const lead of allLeads) {
    if (lead.status === "closed") continue;
    const lastInbound = lead.last_inbound_at ? new Date(lead.last_inbound_at).getTime() : 0;
    const lastOutbound = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;

    if (lastInbound > 0 && lastInbound > lastOutbound) {
      const daysSinceOutbound = lastOutbound > 0 ? (now - lastOutbound) / (1000 * 60 * 60 * 24) : 999;
      if (daysSinceOutbound >= 14) {
        highGhostRisk++;
        ghostRiskContacts.push({ contact_id: lead.id, summary: lead.name, risk: "high" });
      } else if (daysSinceOutbound >= 7) {
        mediumGhostRisk++;
        if (ghostRiskContacts.length < 10) {
          ghostRiskContacts.push({ contact_id: lead.id, summary: lead.name, risk: "medium" });
        }
      }
    }
  }

  // --- Sentiment from deal_outlook ---
  const sentimentDist: Record<string, number> = {};
  for (const lead of allLeads) {
    const s = lead.deal_outlook ?? "neutral";
    sentimentDist[s] = (sentimentDist[s] ?? 0) + 1;
  }

  // --- Active leads (not closed) ---
  const activeLeads = allLeads.filter((l: any) => l.status !== "closed").length;

  // --- Top topics: derive from lead stages as basic topics ---
  const topTopics = Object.entries(stageDist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));

  return {
    avg_response_time_minutes: Math.round(avgResponseTime * 10) / 10,
    median_response_time_minutes: Math.round(medianResponseTime * 10) / 10,
    needs_reply_count: needsReplyCount,
    stage_distribution: stageDist,
    objection_frequency: {},
    high_ghost_risk_count: highGhostRisk,
    medium_ghost_risk_count: mediumGhostRisk,
    ghost_risk_contacts: ghostRiskContacts,
    channel_metrics: channelMetrics,
    total_conversations: leadIds.length,
    total_messages_sent: totalSent,
    total_messages_received: totalReceived,
    active_conversations: activeLeads,
    sentiment_distribution: sentimentDist,
    urgency_distribution: {},
    top_topics: topTopics,
  };
}
