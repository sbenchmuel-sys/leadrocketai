// ============================================================
// Call API — CRUD/read endpoints for call data
// GET /call-api?callSid=... or ?callSessionId=... or ?leadId=...
// Returns session + recordings + transcript + analysis
//
// AUTH: Requires a valid user JWT. All queries are scoped to
// workspaces the caller belongs to via assertCallSessionAccess
// or assertWorkspaceMembership. Internal callers (X-Internal-Secret)
// bypass user checks but still use service-role queries.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  requireAuth,
  assertCallSessionAccess,
  assertLeadAccess,
} from "../_shared/authz.ts";

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
  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Auth gate ──────────────────────────────────────────────
  const authResult = await requireAuth(req, corsHeaders);
  if (authResult instanceof Response) return authResult;

  const { userId, isPrivileged } = authResult;

  const url = new URL(req.url);

  try {
    if (req.method !== "GET") {
      return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const callSid = url.searchParams.get("callSid");
    const callSessionId = url.searchParams.get("callSessionId");
    const leadId = url.searchParams.get("leadId");
    const recent = url.searchParams.get("recent");

    // ── Fetch by callSid ──────────────────────────────────
    if (callSid) {
      const { data: session } = await supabase
        .from("call_sessions")
        .select("*")
        .eq("call_sid", callSid)
        .maybeSingle();

      if (!session) {
        return jsonResp({ ok: false, error: "Not found" }, 404);
      }

      // Ownership check
      if (!isPrivileged && userId) {
        const check = await assertCallSessionAccess(supabase, session.id, userId);
        if (!check.ok) return jsonResp({ ok: false, error: check.error }, check.status ?? 403);
      }

      return fetchFullSession(supabase, session);
    }

    // ── Fetch by session ID ───────────────────────────────
    if (callSessionId) {
      const { data: session } = await supabase
        .from("call_sessions")
        .select("*")
        .eq("id", callSessionId)
        .maybeSingle();

      if (!session) {
        return jsonResp({ ok: false, error: "Not found" }, 404);
      }

      if (!isPrivileged && userId) {
        const check = await assertCallSessionAccess(supabase, session.id, userId);
        if (!check.ok) return jsonResp({ ok: false, error: check.error }, check.status ?? 403);
      }

      return fetchFullSession(supabase, session);
    }

    // ── Fetch by lead ID ──────────────────────────────────
    if (leadId) {
      if (!isPrivileged && userId) {
        const check = await assertLeadAccess(supabase, leadId, userId);
        if (!check.ok) return jsonResp({ ok: false, error: check.error }, check.status ?? 403);
      }

      const { data: sessions } = await supabase
        .from("call_sessions")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(20);

      return jsonResp({ ok: true, sessions: sessions ?? [] });
    }

    // ── Recent webhook logs ───────────────────────────────
    // Only available to privileged callers (internal/service-role)
    if (recent === "webhooks") {
      if (!isPrivileged) {
        return jsonResp({ ok: false, error: "Forbidden — webhook logs require service-role access" }, 403);
      }

      const { data } = await supabase
        .from("call_webhook_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      return jsonResp({ ok: true, webhooks: data ?? [] });
    }

    return jsonResp({ ok: false, error: "Provide callSid, callSessionId, or leadId" }, 400);
  } catch (err) {
    logger.error("call_api_error", { error: err instanceof Error ? err.message : String(err) });
    return jsonResp({ ok: false, error: "Internal error" }, 500);
  }
});

// ── Helpers ─────────────────────────────────────────────────

function jsonResp(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function fetchFullSession(supabase: ReturnType<typeof createClient>, session: Record<string, unknown>) {
  const sessionId = session.id as string;

  const [recordings, transcripts, analyses] = await Promise.all([
    supabase.from("call_recordings").select("*").eq("call_session_id", sessionId),
    supabase.from("call_transcripts").select("*").eq("call_session_id", sessionId),
    supabase.from("call_analyses").select("*").eq("call_session_id", sessionId),
  ]);

  return jsonResp({
    ok: true,
    session,
    recordings: recordings.data ?? [],
    transcripts: transcripts.data ?? [],
    analyses: analyses.data ?? [],
  });
}
