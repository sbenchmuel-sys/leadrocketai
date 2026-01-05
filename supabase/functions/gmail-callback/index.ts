import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      console.error("[gmail-callback] OAuth error:", error);
      return new Response(`<html><body><h1>Authentication Failed</h1><p>${error}</p><script>setTimeout(() => window.close(), 3000);</script></body></html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (!code || !state) {
      return new Response(`<html><body><h1>Invalid Request</h1><p>Missing code or state</p></body></html>`, {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    // Parse state
    let stateData: { user_id: string; redirect_url: string };
    try {
      stateData = JSON.parse(atob(state));
    } catch {
      return new Response(`<html><body><h1>Invalid State</h1></body></html>`, {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
      const errorText = await tokenResponse.text();
      console.error("[gmail-callback] Token exchange failed:", errorText);
      return new Response(`<html><body><h1>Token Exchange Failed</h1><p>${errorText}</p></body></html>`, {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }

    const tokens = await tokenResponse.json();
    const { access_token, refresh_token, expires_in } = tokens;

    if (!access_token || !refresh_token) {
      console.error("[gmail-callback] Missing tokens in response:", tokens);
      return new Response(`<html><body><h1>Invalid Token Response</h1><p>Missing access or refresh token</p></body></html>`, {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }

    // Get user's Gmail address
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userInfoResponse.ok) {
      console.error("[gmail-callback] Failed to get user info");
      return new Response(`<html><body><h1>Failed to Get User Info</h1></body></html>`, {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }

    const userInfo = await userInfoResponse.json();
    const gmailEmail = userInfo.email;

    // Calculate token expiry
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // Store connection using service role key (bypasses RLS for upsert)
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
      console.error("[gmail-callback] Failed to save connection:", upsertError);
      return new Response(`<html><body><h1>Database Error</h1><p>${upsertError.message}</p></body></html>`, {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }

    console.log(`[gmail-callback] Successfully connected Gmail for user ${stateData.user_id}: ${gmailEmail}`);

    // Show success and close the popup window
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
            <p>Connected: ${gmailEmail}</p>
            <p>This window will close automatically...</p>
          </div>
          <script>
            // Close popup after brief delay
            setTimeout(() => window.close(), 1500);
          </script>
        </body>
      </html>
    `, {
      headers: { "Content-Type": "text/html" },
    });
  } catch (error) {
    console.error("[gmail-callback] Error:", error);
    return new Response(`<html><body><h1>Error</h1><p>${error instanceof Error ? error.message : "Unknown error"}</p></body></html>`, {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
});
