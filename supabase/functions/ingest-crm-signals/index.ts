import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { ingestSignals, type SignalInput } from "../_shared/signalIngestion.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// CRM event types that generate signals
const CRM_EVENT_SIGNAL_MAP: Record<string, { signal_type: string; description: string; confidence: number }> = {
  email_open: {
    signal_type: "email_engagement",
    description: "Lead opened an email — showing interest",
    confidence: 0.5,
  },
  email_click: {
    signal_type: "link_clicked",
    description: "Lead clicked a link in email — high engagement",
    confidence: 0.8,
  },
  meeting_booked: {
    signal_type: "meeting_scheduled",
    description: "Lead booked a meeting — strong buying signal",
    confidence: 0.9,
  },
  meeting_completed: {
    signal_type: "meeting_completed",
    description: "Meeting with lead completed successfully",
    confidence: 0.85,
  },
  reply_received: {
    signal_type: "reply_received",
    description: "Lead replied to outreach — active engagement",
    confidence: 0.75,
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Accept both service-role and user JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    const isServiceRole = token === serviceKey;

    if (!isServiceRole) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data, error } = await userClient.auth.getUser();
      if (error || !data?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const body = await req.json();
    const { lead_id, event_type, detail } = body as {
      lead_id: string;
      event_type: string;
      detail?: Record<string, unknown>;
    };

    if (!lead_id || !event_type) {
      return new Response(JSON.stringify({ error: "lead_id and event_type are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const mapping = CRM_EVENT_SIGNAL_MAP[event_type];
    if (!mapping) {
      return new Response(JSON.stringify({ error: `Unknown event_type: ${event_type}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const signal: SignalInput = {
      lead_id,
      signal_type: mapping.signal_type,
      signal_description: mapping.description,
      signal_source: "crm_activity",
      confidence_score: mapping.confidence,
      source_detail: detail ?? null,
    };

    const admin = createClient(supabaseUrl, serviceKey);
    const result = await ingestSignals(admin, [signal]);

    logger.info("crm_signal_ingested", { lead_id, event_type, ...result });

    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error("crm_signal_error", { error: String(err) });
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
