// ============================================================================
// outreach-unsubscribe — PUBLIC one-click unsubscribe for cold outreach (Unit C)
//
// Unauthenticated by design (config.toml: verify_jwt = false) — email clients and
// recipients open this with no session. Its ENTIRE security rests on the signed
// HMAC token (see _shared/outreachUnsubscribeToken.ts) keyed by UNSUBSCRIBE_TOKEN_SECRET.
// A raw lead_id is NEVER accepted; a forged/tampered token is rejected. If the
// secret is unset, verification fails closed (rejects everything).
//
// Handles GET (link click → confirmation page) and POST (RFC 8058 List-Unsubscribe
// one-click). On a valid token it: sets leads.unsubscribed=true, halts automation
// for the lead, stops any active cold enrollment, and adds the address to the
// workspace do-not-contact list — so the lead is never cold-emailed again (the
// enrollment + send floor both fail closed on unsubscribed + suppression).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyUnsubscribeToken, getUnsubscribeSecret } from "../_shared/outreachUnsubscribeToken.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function page(title: string, message: string, status = 200): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#222;text-align:center">
<h1 style="font-size:20px">${title}</h1>
<p style="color:#555;line-height:1.6">${message}</p>
</body></html>`;
  return new Response(html, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Token can arrive in the query (?token=) for GET clicks or POST one-click.
  const url = new URL(req.url);
  let token = url.searchParams.get("token") || "";
  if (!token && req.method === "POST") {
    try {
      const ct = req.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        token = (await req.json())?.token || "";
      } else {
        const form = await req.formData().catch(() => null);
        token = (form?.get("token") as string) || "";
      }
    } catch { /* ignore */ }
  }

  const secret = getUnsubscribeSecret();
  const payload = await verifyUnsubscribeToken(token, secret);
  if (!payload) {
    // Fail closed and generic — never reveal whether a lead exists.
    return page("Link not valid", "This unsubscribe link is invalid or has expired. If you keep receiving emails, just reply with “unsubscribe”.", 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Verify the lead exists in the token's workspace (token is signed, but this
  // guards a stale/rotated lead and gives us the email for the suppression entry).
  const { data: lead } = await supabase
    .from("leads")
    .select("id, email, workspace_id")
    .eq("id", payload.lid)
    .eq("workspace_id", payload.wid)
    .maybeSingle();
  if (!lead) {
    // Token verified but lead is gone — treat as already removed (idempotent).
    return page("You're unsubscribed", "You won't receive any more emails from us.");
  }

  // 1) Halt the lead: opt-out flag + clear any pending automation action.
  await supabase.from("leads").update({
    unsubscribed: true,
    needs_action: false,
    eligible_at: null,
    next_action_key: null,
    next_action_label: null,
    action_reason_code: null,
  }).eq("id", lead.id);

  // 2) Stop any active cold enrollment(s) so the scheduler/executor drop the lead.
  await supabase.from("campaign_enrollment")
    .update({ status: "stopped" })
    .eq("lead_id", lead.id)
    .in("status", ["scheduled", "active"]);
  // 2b) Clear the lead's still-pending touches (mirrors endColdEnrollment). The
  //     scheduler/executor query campaign_touch by status/eligible_at BEFORE checking
  //     enrollment status, so a 'scheduled'/'queued' touch left behind by an
  //     unsubscribe would keep being re-selected and skipped — occupying the capped
  //     batch and starving live touches. A fully-unsubscribed lead's entire cold
  //     cadence is dead, so scope by lead.
  await supabase.from("campaign_touch")
    .update({ status: "skipped" })
    .eq("lead_id", lead.id)
    .in("status", ["scheduled", "queued"]);

  // 3) Add the address to the workspace do-not-contact list (idempotent on the
  //    table's UNIQUE constraint) so re-enrollment also fails closed.
  const email = (lead.email || "").trim().toLowerCase();
  if (email.includes("@")) {
    await supabase.from("campaign_suppression_list")
      .upsert(
        { workspace_id: lead.workspace_id, kind: "email", value: email },
        { onConflict: "workspace_id,kind,value", ignoreDuplicates: true },
      );
  }

  console.log(`[outreach-unsubscribe] lead ${lead.id} (ws ${lead.workspace_id}) unsubscribed via ${req.method}`);
  return page("You're unsubscribed", "You won't receive any more emails from us. Sorry for the interruption.");
});
