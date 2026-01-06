import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// HTML escape function to prevent XSS
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Security headers for HTML responses
function getSecureHtmlHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html",
    "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline';",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

// Generic error page that doesn't leak details
function errorPage(title: string, message: string): string {
  return `<html><head><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;}.container{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);}h1{color:#ef4444;margin-bottom:1rem;}p{color:#666;}</style></head><body><div class="container"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>This window will close automatically...</p></div><script>setTimeout(() => window.close(), 3000);</script></body></html>`;
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      const errorId = crypto.randomUUID();
      console.error(`[gmail-callback] OAuth error ${errorId}:`, error);
      return new Response(errorPage("Authentication Failed", "Unable to connect to Gmail. Please try again."), {
        headers: getSecureHtmlHeaders(),
      });
    }

    if (!code || !state) {
      return new Response(errorPage("Invalid Request", "Missing required parameters."), {
        status: 400,
        headers: getSecureHtmlHeaders(),
      });
    }

    // Parse state
    let stateData: { user_id: string; redirect_url: string; csrf: string; origin?: string };
    try {
      stateData = JSON.parse(atob(state));
    } catch {
      return new Response(errorPage("Invalid Request", "Invalid state parameter."), {
        status: 400,
        headers: getSecureHtmlHeaders(),
      });
    }

    // Validate required state fields
    if (!stateData.user_id || !stateData.csrf) {
      const errorId = crypto.randomUUID();
      console.error(`[gmail-callback] Missing user_id or csrf in state, errorId: ${errorId}`);
      return new Response(errorPage("Invalid Request", "Invalid state data."), {
        status: 400,
        headers: getSecureHtmlHeaders(),
      });
    }

    const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify CSRF token from database
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    const { data: storedState, error: stateError } = await supabase
      .from("oauth_states")
      .select("*")
      .eq("user_id", stateData.user_id)
      .eq("csrf_token", stateData.csrf)
      .single();

    if (stateError || !storedState) {
      const errorId = crypto.randomUUID();
      console.error(`[gmail-callback] Invalid or missing CSRF token, errorId: ${errorId}`);
      return new Response(errorPage("Session Invalid", "OAuth session expired or invalid. Please try again."), {
        status: 400,
        headers: getSecureHtmlHeaders(),
      });
    }

    // Check if token has expired
    if (new Date(storedState.expires_at) < new Date()) {
      const errorId = crypto.randomUUID();
      console.error(`[gmail-callback] CSRF token expired, errorId: ${errorId}`);
      // Clean up expired token
      await supabase.from("oauth_states").delete().eq("id", storedState.id);
      return new Response(errorPage("Session Expired", "OAuth session expired. Please try again."), {
        status: 400,
        headers: getSecureHtmlHeaders(),
      });
    }

    // Delete the used CSRF token to prevent replay attacks
    await supabase.from("oauth_states").delete().eq("id", storedState.id);

    const callbackUrl = `${supabaseUrl}/functions/v1/gmail-callback`;

    // Exchange code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorId = crypto.randomUUID();
      const errorText = await tokenResponse.text();
      console.error(`[gmail-callback] Token exchange failed, errorId: ${errorId}:`, errorText);
      return new Response(errorPage("Connection Failed", "Failed to complete Gmail connection. Please try again."), {
        status: 500,
        headers: getSecureHtmlHeaders(),
      });
    }

    const tokens = await tokenResponse.json();
    const { access_token, refresh_token, expires_in } = tokens;

    if (!access_token || !refresh_token) {
      const errorId = crypto.randomUUID();
      console.error(`[gmail-callback] Missing tokens in response, errorId: ${errorId}:`, tokens);
      return new Response(errorPage("Connection Failed", "Invalid response from Gmail. Please try again."), {
        status: 500,
        headers: getSecureHtmlHeaders(),
      });
    }

    // Get user's Gmail address
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userInfoResponse.ok) {
      const errorId = crypto.randomUUID();
      console.error(`[gmail-callback] Failed to get user info, errorId: ${errorId}`);
      return new Response(errorPage("Connection Failed", "Failed to retrieve Gmail information. Please try again."), {
        status: 500,
        headers: getSecureHtmlHeaders(),
      });
    }

    const userInfo = await userInfoResponse.json();
    const gmailEmail = userInfo.email;

    // Calculate token expiry
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // Store connection using service role key (bypasses RLS for upsert)
    const { error: upsertError } = await supabase
      .from("gmail_connections")
      .upsert({
        user_id: stateData.user_id,
        gmail_email: gmailEmail,
        access_token,
        refresh_token,
        token_expires_at: tokenExpiresAt,
      }, { onConflict: "user_id" });

    if (upsertError) {
      const errorId = crypto.randomUUID();
      console.error(`[gmail-callback] Failed to save connection, errorId: ${errorId}:`, upsertError);
      return new Response(errorPage("Connection Failed", "Failed to save Gmail connection. Please try again."), {
        status: 500,
        headers: getSecureHtmlHeaders(),
      });
    }

    console.log(`[gmail-callback] Successfully connected Gmail for user ${stateData.user_id}: ${gmailEmail}`);

    // Determine the allowed origin for postMessage
    // Use the origin from state, or derive from redirect_url
    let allowedOrigin = stateData.origin || "";
    if (!allowedOrigin && stateData.redirect_url) {
      try {
        allowedOrigin = new URL(stateData.redirect_url).origin;
      } catch {
        // If redirect_url is not a valid URL, leave origin empty
        allowedOrigin = "";
      }
    }

    // Escape the email for safe display
    const safeEmail = escapeHtml(gmailEmail);
    const safeOrigin = escapeHtml(allowedOrigin);

    // Show success, notify opener via postMessage with specific origin, and close the popup window
    return new Response(`
      <html>
        <head>
          <style>
            body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f5f5; }
            .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #22c55e; margin-bottom: 1rem; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✓ Gmail Connected!</h1>
            <p>Connected: ${safeEmail}</p>
            <p>This window will close automatically...</p>
          </div>
          <script>
            // Notify opener that connection succeeded using specific origin
            if (window.opener) {
              var allowedOrigin = "${safeOrigin}";
              if (allowedOrigin) {
                window.opener.postMessage({ type: "GMAIL_CONNECTED" }, allowedOrigin);
              } else {
                // Fallback: Only post to same origin
                window.opener.postMessage({ type: "GMAIL_CONNECTED" }, window.location.origin);
              }
            }
            // Close popup after brief delay
            setTimeout(function() { window.close(); }, 1500);
          </script>
        </body>
      </html>
    `, {
      headers: getSecureHtmlHeaders(),
    });
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[gmail-callback] Unexpected error, errorId: ${errorId}:`, error);
    return new Response(`<html><head><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;}.container{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);}h1{color:#ef4444;margin-bottom:1rem;}p{color:#666;}</style></head><body><div class="container"><h1>Error</h1><p>An unexpected error occurred. Please try again.</p><p>Error ID: ${errorId}</p></div></body></html>`, {
      status: 500,
      headers: getSecureHtmlHeaders(),
    });
  }
});