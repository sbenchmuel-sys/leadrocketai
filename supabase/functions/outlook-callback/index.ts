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
function errorPage(title: string, msg: string, diagnostic?: string): string {
  const diagBlock = diagnostic
    ? `<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:#f3f4f6;color:#374151;padding:.75rem;border-radius:6px;text-align:left;white-space:pre-wrap;word-break:break-word;margin-top:1rem;max-width:520px">${escapeHtml(diagnostic)}</pre>`
    : "";
  return `<html><head><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}.box{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);max-width:560px}h1{color:#ef4444}p{color:#666}</style></head><body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(msg)}</p>${diagBlock}<p style="font-size:12px;color:#9ca3af">This window will close automatically…</p></div><script>setTimeout(()=>window.close(),8000)</script></body></html>`;
}

function adminConsentPage(consentUrl: string, diagnostic: string): string {
  return `<html><head><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}.box{padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);max-width:620px}h1{color:#0f172a;margin-top:0}p{color:#475569;line-height:1.5}.url{display:flex;gap:.5rem;margin:1rem 0;align-items:stretch}input{flex:1;padding:.6rem .75rem;border:1px solid #cbd5e1;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f8fafc;color:#0f172a}button{padding:.6rem 1rem;border:0;border-radius:6px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}button:hover{background:#1d4ed8}.ok{color:#16a34a;font-size:13px;margin-left:.5rem}pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:#f3f4f6;color:#374151;padding:.75rem;border-radius:6px;white-space:pre-wrap;word-break:break-word}</style></head><body><div class="box"><h1>Your IT admin needs to approve this app</h1><p>Forward the link below to a <strong>Global Admin</strong> or <strong>Cloud Application Administrator</strong> in your Microsoft 365 tenant. Once they grant consent, return here and try connecting again.</p><div class="url"><input id="u" readonly value="${escapeHtml(consentUrl)}"/><button onclick="navigator.clipboard.writeText(document.getElementById('u').value).then(()=>{document.getElementById('s').textContent='Copied ✓'})">Copy</button></div><span id="s" class="ok"></span><p style="font-size:12px;color:#94a3b8;margin-top:1.5rem">Diagnostic info (for support):</p><pre>${escapeHtml(diagnostic)}</pre></div></body></html>`;
}

function extractAadsts(text: string): string | null {
  const m = /AADSTS(\d+)/.exec(text || "");
  return m ? m[1] : null;
}

function renderAadstsResponse(
  aadstsCode: string | null,
  errorDescription: string,
  stage: "oauth_error" | "token_exchange",
): Response {
  logger.error("mail.outlook.callback_aadsts_detected", {
    aadsts_code: aadstsCode,
    error_description: errorDescription,
    stage,
  });

  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID") ?? "";
  const diagnostic = `AADSTS${aadstsCode ?? "?"} (${stage})\n${(errorDescription || "").slice(0, 200)}`;

  if (aadstsCode === "65001" || aadstsCode === "90094") {
    const consentUrl = `https://login.microsoftonline.com/common/adminconsent?client_id=${encodeURIComponent(clientId)}`;
    return new Response(adminConsentPage(consentUrl, diagnostic), { headers: HTML_HEADERS });
  }

  if (aadstsCode === "50194" || aadstsCode === "500011") {
    return new Response(
      errorPage(
        "This app isn't enabled for your organization yet",
        "Your Microsoft 365 tenant isn't configured to use this application. Please contact support — there is no self-serve fix for this.",
        diagnostic,
      ),
      { headers: HTML_HEADERS },
    );
  }

  return new Response(
    errorPage(
      "Connection Failed",
      "Microsoft declined the request. Please try again, or contact support with the details below.",
      diagnostic,
    ),
    { status: 500, headers: HTML_HEADERS },
  );
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

    // --- Check if this is the first Outlook account in the workspace ---
    const { count: existingCount } = await serviceClient
      .from("mail_accounts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", stateData.workspace_id)
      .eq("provider", "outlook");

    const isDefault = (existingCount ?? 0) === 0;

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
