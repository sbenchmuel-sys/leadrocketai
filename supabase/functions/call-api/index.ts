// ============================================================
// Call API — CRUD/read endpoints for call data
// GET /call-api?callSid=... or ?callSessionId=...
// Returns session + recordings + transcript + analysis
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Auth: validate user token
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  const supabase = createClient(supabaseUrl, serviceKey);

  // Verify the calling user
  if (token && token !== serviceKey) {
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? serviceKey);
    const { data: { user }, error: authErr } = await userClient.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const callSid = url.searchParams.get("callSid");
      const callSessionId = url.searchParams.get("callSessionId");
      const leadId = url.searchParams.get("leadId");
      const recent = url.searchParams.get("recent");

      // Fetch by callSid
      if (callSid) {
        return await fetchByCallSid(supabase, callSid);
      }

      // Fetch by session ID
      if (callSessionId) {
        return await fetchBySessionId(supabase, callSessionId);
      }

      // Fetch by lead ID
      if (leadId) {
        return await fetchByLeadId(supabase, leadId);
      }

      // Fetch recent webhook deliveries
      if (recent === "webhooks") {
        const { data } = await supabase
          .from("call_webhook_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50);

        return new Response(JSON.stringify({ ok: true, webhooks: data ?? [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: false, error: "Provide callSid, callSessionId, or leadId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error("call_api_error", { error: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ ok: false, error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function fetchByCallSid(supabase: ReturnType<typeof createClient>, callSid: string) {
  const { data: session } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("call_sid", callSid)
    .maybeSingle();

  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  return fetchFullSession(supabase, session);
}

async function fetchBySessionId(supabase: ReturnType<typeof createClient>, id: string) {
  const { data: session } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  return fetchFullSession(supabase, session);
}

async function fetchByLeadId(supabase: ReturnType<typeof createClient>, leadId: string) {
  const { data: sessions } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(20);

  return new Response(JSON.stringify({ ok: true, sessions: sessions ?? [] }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function fetchFullSession(supabase: ReturnType<typeof createClient>, session: Record<string, unknown>) {
  const sessionId = session.id as string;

  const [recordings, transcripts, analyses] = await Promise.all([
    supabase.from("call_recordings").select("*").eq("call_session_id", sessionId),
    supabase.from("call_transcripts").select("*").eq("call_session_id", sessionId),
    supabase.from("call_analyses").select("*").eq("call_session_id", sessionId),
  ]);

  return new Response(JSON.stringify({
    ok: true,
    session,
    recordings: recordings.data ?? [],
    transcripts: transcripts.data ?? [],
    analyses: analyses.data ?? [],
  }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
