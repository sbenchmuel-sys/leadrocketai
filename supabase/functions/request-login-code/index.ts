// ============================================================================
// request-login-code — PUBLIC "Email me a code" sign-in (config.toml: verify_jwt = false;
// the caller has no session yet).
//
// Sends a Supabase Auth one-time code (magic-link email) to:
//   • an address that already has an account, or
//   • an address with a PENDING workspace invitation — this is how a newly invited
//     rep/manager gets in without ever setting a password (WorkspaceContext then
//     joins them to the invited workspace on first load).
// Any other address gets nothing: no account is created, honouring "no public
// signup during the pilot". The response is the same {ok:true} in every case so
// the endpoint can't be used to discover which addresses have accounts.
//
// Abuse ceiling: relies on Supabase Auth's built-in per-address OTP rate limit
// (one email per ~60s). ponytail: no per-IP limit — add one if this gets hammered.
// The browser verifies the code itself with supabase.auth.verifyOtp.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizeLoginEmail } from "../_shared/loginCode.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: { email?: unknown; redirectTo?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }
  const email = normalizeLoginEmail(body.email);
  if (!email) return json({ ok: false, error: "Enter a valid email address" }, 400);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const anon = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });

  const { data: invitation, error: invErr } = await admin
    .from("workspace_invitations")
    .select("id")
    .eq("email", email)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (invErr) {
    console.error("[request-login-code] invitation lookup failed", invErr.message);
    return json({ ok: false, error: "Couldn't send a code right now. Try again in a minute." }, 500);
  }

  // The link in the same email must land on the app, never on an arbitrary site.
  const redirectTo = typeof body.redirectTo === "string" && /^https:\/\/([a-z0-9-]+\.)*(drivepilot\.app|lovable\.app)\/?$/i.test(body.redirectTo)
    ? body.redirectTo
    : "https://www.drivepilot.app/";

  const { error } = await anon.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: !!invitation, emailRedirectTo: redirectTo },
  });

  if (error) {
    // "Signups not allowed for otp" = unknown, uninvited address. A rate-limit hit only
    // happens for real accounts, so it gets the same answer too (the page already
    // enforces a 60s wait before "Send again").
    if (/signups? not allowed/i.test(error.message) || error.status === 429 || /rate limit|security purposes/i.test(error.message)) {
      return json({ ok: true });
    }
    console.error("[request-login-code] signInWithOtp failed", error.status, error.message);
    return json({ ok: false, error: "Couldn't send a code right now. Try again in a minute." }, 500);
  }
  return json({ ok: true });
});
