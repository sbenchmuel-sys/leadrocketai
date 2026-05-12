// ============================================================
// outlook-auth — generates Microsoft OAuth URL
// POST /outlook-auth  { redirectUrl: string }
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { OUTLOOK_FULL_OAUTH_SCOPES_STRING } from "../_shared/outlookScopes.ts";

function corsHeaders(origin: string): Record<string, string> {
  const allowed =
    origin.includes("localhost") ||
    origin.endsWith(".lovableproject.com") ||
    origin.endsWith(".lovable.app") ||
    origin === "https://drivepilot.app" ||
    origin === "https://www.drivepilot.app";
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Body may only contain workspaceId (redirectUrl is optional)
    const body = await req.json().catch(() => ({}));
    const workspaceId: string | undefined = body.workspaceId ?? body.workspace_id;
    const redirectUrl: string | undefined = body.redirectUrl ?? body.redirect_url;

    // Check credentials first (before requiring workspaceId) so probe requests work
    const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
    const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      logger.warn("mail.outlook.credentials_missing", { step: "auth" });
      return new Response(
        JSON.stringify({ ok: false, error: "Microsoft credentials not configured", not_configured: true }),
        { status: 503, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // If no workspaceId, this is a probe-only request to check credentials
    if (!workspaceId) {
      return new Response(JSON.stringify({ ok: true, configured: true }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Generate CSRF token and store in oauth_states (reuse existing table)
    const csrfToken = crypto.randomUUID();
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    await serviceClient.from("oauth_states").insert({
      user_id: user.id,
      csrf_token: csrfToken,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    const state = btoa(JSON.stringify({
      user_id: user.id,
      workspace_id: workspaceId,
      redirect_url: redirectUrl,
      csrf: csrfToken,
      provider: "outlook",
    }));

    const callbackUrl = `${supabaseUrl}/functions/v1/outlook-callback`;

    const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", callbackUrl);
    authUrl.searchParams.set("scope", OUTLOOK_FULL_OAUTH_SCOPES_STRING);
    authUrl.searchParams.set("response_mode", "query");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "select_account");

    logger.info("mail.outlook.connected", {
      user_id: user.id,
      workspace_id: workspaceId,
      step: "auth_url_generated",
    });

    return new Response(JSON.stringify({ ok: true, authUrl: authUrl.toString() }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    const errorId = crypto.randomUUID();
    logger.error("mail.outlook.auth_error", { error_id: errorId, error: String(err) });
    return new Response(JSON.stringify({ ok: false, error: "Internal error", error_id: errorId }), {
      status: 500,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }
});
