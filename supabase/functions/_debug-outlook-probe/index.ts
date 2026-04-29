// ============================================================
// _debug-outlook-probe — TEMPORARY one-off diagnostic.
// Probes a specific mail_account: refreshes token, calls /me,
// lists 1 message, attempts POST /subscriptions, reports raw
// Graph responses. DELETE AFTER USE.
//
// Auth: requires X-Internal-Secret header.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");
  const provided = req.headers.get("X-Internal-Secret");
  if (!internalSecret || provided !== internalSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { mail_account_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const mailAccountId = body.mail_account_id;
  if (!mailAccountId) return json({ error: "mail_account_id required" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const service = createClient(supabaseUrl, serviceKey);

  const result: Record<string, unknown> = { mail_account_id: mailAccountId };

  // 1. Refresh / fetch token
  let accessToken: string;
  try {
    accessToken = await getFreshOutlookToken(mailAccountId, service);
    result.token_ok = true;
    result.token_preview = `${accessToken.slice(0, 12)}...${accessToken.slice(-6)} (len=${accessToken.length})`;
  } catch (err) {
    result.token_ok = false;
    result.token_error = err instanceof Error ? err.message : String(err);
    return json(result, 200);
  }

  // Decode JWT payload to inspect scopes/tenant/aud (no signature check)
  try {
    const parts = accessToken.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      result.token_claims = {
        aud: payload.aud,
        iss: payload.iss,
        tid: payload.tid,
        upn: payload.upn ?? payload.unique_name ?? payload.preferred_username,
        scp: payload.scp,
        roles: payload.roles,
        app_displayname: payload.app_displayname,
        appid: payload.appid,
        exp: payload.exp,
      };
    }
  } catch (e) {
    result.token_decode_error = e instanceof Error ? e.message : String(e);
  }

  // 2. GET /me
  result.me = await graphCall("https://graph.microsoft.com/v1.0/me", accessToken);

  // 3. GET /me/messages?$top=1
  result.messages = await graphCall(
    "https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=subject,from,receivedDateTime",
    accessToken,
  );

  // 4. POST /subscriptions — the failing call
  const webhookUrl = `${supabaseUrl}/functions/v1/outlook-webhook`;
  const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const subBody = {
    changeType: "created",
    notificationUrl: webhookUrl,
    resource: "/me/mailFolders('Inbox')/messages",
    expirationDateTime: expiresAt,
    clientState: crypto.randomUUID(),
  };
  result.subscription_attempt_body = subBody;
  const subResp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(subBody),
  });
  const subText = await subResp.text();
  result.subscription = {
    status: subResp.status,
    headers: {
      "request-id": subResp.headers.get("request-id"),
      "client-request-id": subResp.headers.get("client-request-id"),
      "x-ms-ags-diagnostic": subResp.headers.get("x-ms-ags-diagnostic"),
    },
    body: safeParse(subText),
  };

  // If created successfully, immediately delete it so we don't leave a dangling sub
  if (subResp.ok) {
    try {
      const created = JSON.parse(subText);
      if (created.id) {
        const del = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${created.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        result.subscription_cleanup_status = del.status;
      }
    } catch { /* ignore */ }
  }

  return json(result, 200);
});

async function graphCall(url: string, token: string) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    return {
      status: r.status,
      body: safeParse(text),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text.slice(0, 800); }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
