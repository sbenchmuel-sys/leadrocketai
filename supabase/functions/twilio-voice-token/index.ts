// ============================================================
// Twilio Voice Token — generates short-lived Access Tokens
// with a Voice Grant so the browser SDK can make/receive calls
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Twilio JWT helper — we build the token manually because Deno
// doesn't have the Node twilio helper lib available.
function base64url(input: Uint8Array): string {
  return btoa(String.fromCharCode(...input))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function textToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textToBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textToBytes(data));
  return base64url(new Uint8Array(sig));
}

async function createTwilioAccessToken(opts: {
  accountSid: string;
  apiKey: string;
  apiSecret: string;
  identity: string;
  twimlAppSid: string;
  ttl?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttl ?? 600; // 10 minutes

  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const grants: Record<string, unknown> = {
    identity: opts.identity,
    voice: {
      incoming: { allow: true },
      outgoing: { application_sid: opts.twimlAppSid },
    },
  };

  const payload = {
    jti: `${opts.apiKey}-${now}`,
    iss: opts.apiKey,
    sub: opts.accountSid,
    iat: now,
    exp: now + ttl,
    grants,
  };

  const segments = [
    base64url(textToBytes(JSON.stringify(header))),
    base64url(textToBytes(JSON.stringify(payload))),
  ];

  const signature = await hmacSign(opts.apiSecret, segments.join("."));
  return [...segments, signature].join(".");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  const twilioAccountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const twilioApiKey = Deno.env.get("TWILIO_API_KEY");
  const twilioApiSecret = Deno.env.get("TWILIO_API_SECRET");
  const twimlAppSid = Deno.env.get("TWILIO_TWIML_APP_SID");

  // === DIAGNOSTIC: Log exact values (redacted secrets) ===
  logger.info("twilio_voice_token_config", {
    accountSid: twilioAccountSid ?? "MISSING",
    apiKey: twilioApiKey ?? "MISSING",
    apiSecretSet: !!twilioApiSecret,
    twimlAppSid: twimlAppSid ?? "MISSING",
  });

  // ---- Authenticate user ----
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    logger.error("twilio_voice_token_auth_failed", { error: userErr?.message });
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userId = user.id;

  if (!twilioAccountSid || !twilioApiKey || !twilioApiSecret || !twimlAppSid) {
    logger.error("twilio_voice_token_missing_config");
    return new Response(JSON.stringify({ error: "Twilio voice not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const identity = `user_${userId}`;
    const accessToken = await createTwilioAccessToken({
      accountSid: twilioAccountSid,
      apiKey: twilioApiKey,
      apiSecret: twilioApiSecret,
      identity,
      twimlAppSid,
      ttl: 600,
    });

    logger.info("twilio_voice_token_issued", {
      userId,
      identity,
      accountSid: twilioAccountSid,
      apiKey: twilioApiKey,
      twimlAppSid,
    });

    return new Response(JSON.stringify({ token: accessToken, identity }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error("twilio_voice_token_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response(JSON.stringify({ error: "Failed to generate token" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
