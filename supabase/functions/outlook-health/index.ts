// ============================================================
// GET /outlook-health?workspace_id=<uuid>
//
// Returns mailbox health for all Outlook accounts in workspace:
//   email_address, status, token_expiry, subscription_expiry, last_sync_at
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";

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

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

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

    // Auth check
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

    const url = new URL(req.url);
    const workspaceId = url.searchParams.get("workspace_id");
    if (!workspaceId) {
      return new Response(JSON.stringify({ ok: false, error: "workspace_id required" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // Verify caller is workspace member
    const { data: membership } = await serviceClient
      .from("workspace_members")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!membership) {
      return new Response(JSON.stringify({ ok: false, error: "Forbidden" }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Fetch Outlook accounts
    const { data: accounts, error: acctError } = await serviceClient
      .from("mail_accounts")
      .select("id, email_address, status, token_expires_at, last_sync_at, error_reason, is_default")
      .eq("workspace_id", workspaceId)
      .eq("provider", "outlook")
      .order("created_at", { ascending: true });

    if (acctError) {
      logger.error("mail.outlook.health_query_failed", { workspace_id: workspaceId, error: acctError.message });
      throw acctError;
    }

    // Fetch subscription info for each account
    const accountIds = (accounts ?? []).map((a: { id: string }) => a.id);
    const { data: subs } = await serviceClient
      .from("outlook_subscriptions")
      .select("mail_account_id, expiration_at, status, subscription_id")
      .in("mail_account_id", accountIds.length > 0 ? accountIds : ["00000000-0000-0000-0000-000000000000"])
      .eq("status", "active");

    const subsByAccount = Object.fromEntries(
      (subs ?? []).map((s: { mail_account_id: string; expiration_at: string; status: string; subscription_id: string }) => [
        s.mail_account_id,
        s,
      ])
    );

    const health = (accounts ?? []).map((acct: {
      id: string;
      email_address: string;
      status: string;
      token_expires_at: string | null;
      last_sync_at: string | null;
      error_reason: string | null;
      is_default: boolean;
    }) => {
      const sub = subsByAccount[acct.id];
      return {
        email_address: acct.email_address,
        status: acct.status,
        is_default: acct.is_default,
        token_expiry: acct.token_expires_at,
        subscription_expiry: sub?.expiration_at ?? null,
        subscription_status: sub?.status ?? "none",
        last_sync_at: acct.last_sync_at,
        error_reason: acct.error_reason,
      };
    });

    logger.info("mail.outlook.health_checked", {
      workspace_id: workspaceId,
      account_count: health.length,
    });

    return new Response(JSON.stringify({ ok: true, accounts: health }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    const errorId = crypto.randomUUID();
    logger.error("mail.outlook.health_error", { error_id: errorId, error: String(err) });
    return new Response(JSON.stringify({ ok: false, error: "Internal error", error_id: errorId }), {
      status: 500,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }
});
