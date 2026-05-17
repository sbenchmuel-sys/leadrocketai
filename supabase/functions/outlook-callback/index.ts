// ============================================================
// outlook-callback — OAuth code exchange + subscription creation
//
// Flow:
//   1. Validate CSRF from oauth_states
//   2. Exchange code for tokens
//   3. Fetch /me for email + display name
//   4. Upsert into mail_accounts (encrypted tokens)
//   5. Create Graph subscription for Inbox
//   6. Redirect back to app
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encryptToken } from "../_shared/encryption.ts";
import { createOutlookSubscription } from "../_shared/outlookSubscription.ts";
import { logger } from "../_shared/logger.ts";
import { OUTLOOK_FULL_OAUTH_SCOPES_STRING } from "../_shared/outlookScopes.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function errorPage(title: string, msg: string): string {
  return `<html><head><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}.box{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}h1{color:#ef4444}p{color:#666}</style></head><body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(msg)}</p><p>This window will close automatically…</p></div><script>setTimeout(()=>window.close(),3000)</script></body></html>`;
}
function oauthResultPage(ok: boolean, provider: string, emailOrError?: string): string {
  const payload = JSON.stringify(
    ok
      ? { type: "mail_oauth_result", provider, ok: true, email: emailOrError ?? null }
      : { type: "mail_oauth_result", provider, ok: false, error: emailOrError ?? "Connection failed" }
  ).replace(/</g, "\\u003c");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title><style>html,body{margin:0;width:100%;height:100%;background:#fff}body{display:grid;place-items:center;font:14px system-ui,sans-serif;color:#64748b}</style></head><body><span>Finishing connection…</span><script>(function(){try{if(window.opener&&!window.opener.closed){window.opener.postMessage(${payload},'*')}}catch(e){}setTimeout(function(){window.close()},100)})();</script></body></html>`;
}
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      logger.error("mail.outlook.callback_oauth_error", { error });
      return new Response(errorPage("Authentication Failed", "Microsoft declined the request. Please try again."), {
        headers: HTML_HEADERS,
      });
    }

    if (!code || !stateParam) {
      return new Response(errorPage("Invalid Request", "Missing required parameters."), {
        status: 400, headers: HTML_HEADERS,
      });
    }

    let stateData: { user_id: string; workspace_id: string; redirect_url: string; csrf: string; provider: string };
    try {
      stateData = JSON.parse(atob(stateParam));
    } catch {
      return new Response(errorPage("Invalid Request", "Malformed state parameter."), {
        status: 400, headers: HTML_HEADERS,
      });
    }

    if (!stateData.user_id || !stateData.csrf || stateData.provider !== "outlook") {
      return new Response(errorPage("Invalid Request", "Invalid state data."), {
        status: 400, headers: HTML_HEADERS,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("MICROSOFT_CLIENT_ID")!;
    const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET")!;
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // --- Validate CSRF ---
    const { data: storedState, error: stateErr } = await serviceClient
      .from("oauth_states")
      .select("*")
      .eq("user_id", stateData.user_id)
      .eq("csrf_token", stateData.csrf)
      .single();

    if (stateErr || !storedState) {
      return new Response(errorPage("Session Invalid", "OAuth session expired or invalid. Please try again."), {
        status: 400, headers: HTML_HEADERS,
      });
    }
    if (new Date(storedState.expires_at) < new Date()) {
      await serviceClient.from("oauth_states").delete().eq("id", storedState.id);
      return new Response(errorPage("Session Expired", "Please start the connection again."), {
        status: 400, headers: HTML_HEADERS,
      });
    }
    // Consume CSRF token (one-time use)
    await serviceClient.from("oauth_states").delete().eq("id", storedState.id);

    // --- Exchange code for tokens ---
    const callbackUrl = `${supabaseUrl}/functions/v1/outlook-callback`;
    const tokenResp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
        scope: OUTLOOK_FULL_OAUTH_SCOPES_STRING,
      }),
    });

    if (!tokenResp.ok) {
      const body = await tokenResp.text();
      logger.error("mail.outlook.callback_token_exchange_failed", { status: tokenResp.status, body });
      return new Response(errorPage("Connection Failed", "Failed to exchange code for tokens. Please try again."), {
        status: 500, headers: HTML_HEADERS,
      });
    }

    const tokens = await tokenResp.json();
    const { access_token, refresh_token, expires_in, scope: grantedScopeStr } = tokens;
    const grantedScopes: string[] = typeof grantedScopeStr === "string" && grantedScopeStr.length > 0
      ? grantedScopeStr.split(/\s+/).filter(Boolean)
      : [];

    if (!access_token || !refresh_token) {
      logger.error("mail.outlook.callback_missing_tokens", { tokens });
      return new Response(errorPage("Connection Failed", "Incomplete token response. Please try again."), {
        status: 500, headers: HTML_HEADERS,
      });
    }

    // --- Fetch user info from Graph ---
    const meResp = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!meResp.ok) {
      logger.error("mail.outlook.callback_me_failed", { status: meResp.status });
      return new Response(errorPage("Connection Failed", "Could not retrieve Microsoft account info."), {
        status: 500, headers: HTML_HEADERS,
      });
    }
    const me = await meResp.json();
    const emailAddress: string = me.mail ?? me.userPrincipalName ?? "";
    const displayName: string = me.displayName ?? emailAddress;
    const externalUserId: string = me.id ?? "";

    if (!emailAddress) {
      return new Response(errorPage("Connection Failed", "Could not determine your email address."), {
        status: 500, headers: HTML_HEADERS,
      });
    }

    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // --- Encrypt tokens ---
    const hasKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
    const [encAccess, encRefresh] = await Promise.all([
      hasKey ? encryptToken(access_token) : Promise.resolve(access_token),
      hasKey ? encryptToken(refresh_token) : Promise.resolve(refresh_token),
    ]);

    // --- Determine default flag (one default per workspace across all providers) ---
    const { data: existingDefault } = await serviceClient
      .from("mail_accounts")
      .select("id, email_address")
      .eq("workspace_id", stateData.workspace_id)
      .eq("is_default", true)
      .maybeSingle();

    const isDefault =
      !existingDefault ||
      (existingDefault.email_address ?? "").toLowerCase() ===
        emailAddress.toLowerCase();

    // --- Upsert mail_account ---
    const { data: mailAccount, error: upsertErr } = await serviceClient
      .from("mail_accounts")
      .upsert(
        {
          workspace_id: stateData.workspace_id,
          provider: "outlook",
          email_address: emailAddress,
          display_name: displayName,
          external_user_id: externalUserId,
          user_id: stateData.user_id,
          status: "connected",
          is_default: isDefault,
          access_token: encAccess,
          refresh_token: encRefresh,
          token_expires_at: tokenExpiresAt,
          granted_scopes: grantedScopes,
          needs_reconnect: false,
          error_reason: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,email_address" }
      )
      .select("id")
      .single();

    if (upsertErr || !mailAccount) {
      logger.error("mail.outlook.callback_upsert_failed", { error: upsertErr?.message });
      return new Response(errorPage("Connection Failed", "Failed to save account. Please try again."), {
        status: 500, headers: HTML_HEADERS,
      });
    }

    // --- Create Graph subscription for Inbox (non-fatal if fails) ---
    try {
      await createOutlookSubscription(mailAccount.id, access_token, serviceClient);
    } catch (subErr) {
      // Log but do not block the connect flow — subscription can be created via cron
      logger.warn("mail.outlook.callback_subscription_failed", {
        mail_account_id: mailAccount.id,
        error: String(subErr),
      });
    }

    logger.info("mail.outlook.connected", {
      mail_account_id: mailAccount.id,
      email: emailAddress,
      workspace_id: stateData.workspace_id,
      is_default: isDefault,
    });

    // --- Redirect back to app (or show success page if redirect_url missing) ---
    if (!stateData.redirect_url) {
      // No redirect URL — show a self-closing success page for popup flows
      const successHtml = `<html><head><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}.box{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}h1{color:#16a34a}p{color:#666}</style></head><body><div class="box"><h1>✓ Connected!</h1><p>Your Outlook account has been connected successfully.</p><p>This window will close automatically…</p></div><script>window.close();setTimeout(()=>window.close(),1500)</script></body></html>`;
      return new Response(successHtml, { headers: HTML_HEADERS });
    }

    const redirectTarget = new URL(stateData.redirect_url);
    redirectTarget.searchParams.set("outlook_connected", "true");
    redirectTarget.searchParams.set("outlook_email", emailAddress);

    return new Response(null, {
      status: 302,
      headers: { Location: redirectTarget.toString() },
    });
  } catch (err) {
    const errorId = crypto.randomUUID();
    logger.error("mail.outlook.callback_fatal", { error_id: errorId, error: String(err) });
    return new Response(errorPage("Unexpected Error", `An error occurred (${errorId}). Please try again.`), {
      status: 500,
      headers: HTML_HEADERS,
    });
  }
});
