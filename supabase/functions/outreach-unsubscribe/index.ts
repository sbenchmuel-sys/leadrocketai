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

// Escape any value reflected into HTML (the token comes from the query string and
// is attacker-controllable, so it must never be emitted raw).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// GET confirmation page: a button that POSTs the token back. The actual opt-out
// only happens on POST, so a link prefetch (mailbox/security scanner, link preview)
// can never silently unsubscribe the lead.
function confirmPage(token: string): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribe</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#222;text-align:center">
<h1 style="font-size:20px">Unsubscribe from these emails?</h1>
<p style="color:#555;line-height:1.6">Click the button below to stop receiving emails from us.</p>
<form method="POST">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit" style="margin-top:16px;padding:12px 24px;font-size:15px;color:#fff;background:#222;border:none;border-radius:6px;cursor:pointer">Unsubscribe me</button>
</form>
</body></html>`;
  return new Response(html, {
    status: 200,
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

  // A GET is a link click OR an unsolicited prefetch (mailbox/security scanner,
  // link-preview crawler). NEVER mutate on GET — that would let a prefetch opt the
  // lead out before they ever asked. Render a confirmation page whose button POSTs
  // back; the opt-out below runs only for POST (the form button AND the RFC 8058
  // List-Unsubscribe one-click are both POST). This keeps GET safe/idempotent.
  if (req.method !== "POST") {
    return confirmPage(token);
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

  // Supabase writes return { error } rather than throwing. Every write below is
  // idempotent, so on ANY failure we report a non-success page (and a 500 lets the
  // one-click client retry) instead of falsely telling the recipient they're
  // unsubscribed while the opt-out didn't persist — which would leave them eligible
  // for future sends, breaking the public unsubscribe guarantee.
  const errors: string[] = [];

  // 1) Halt the lead: opt-out flag + clear any pending automation action.
  const { error: leadErr } = await supabase.from("leads").update({
    unsubscribed: true,
    needs_action: false,
    eligible_at: null,
    next_action_key: null,
    next_action_label: null,
    action_reason_code: null,
  }).eq("id", lead.id);
  if (leadErr) errors.push(`lead: ${leadErr.message}`);

  // 2) Stop any active cold enrollment(s) so the scheduler/executor drop the lead.
  const { error: enrErr } = await supabase.from("campaign_enrollment")
    .update({ status: "stopped" })
    .eq("lead_id", lead.id)
    .in("status", ["scheduled", "active"]);
  if (enrErr) errors.push(`enrollment: ${enrErr.message}`);
  // 2b) Clear the lead's still-pending touches (mirrors endColdEnrollment). The
  //     scheduler/executor query campaign_touch by status/eligible_at BEFORE checking
  //     enrollment status, so a 'scheduled'/'queued' touch left behind by an
  //     unsubscribe would keep being re-selected and skipped — occupying the capped
  //     batch and starving live touches. A fully-unsubscribed lead's entire cold
  //     cadence is dead, so scope by lead.
  const { error: touchErr } = await supabase.from("campaign_touch")
    .update({ status: "skipped" })
    .eq("lead_id", lead.id)
    .in("status", ["scheduled", "queued"]);
  if (touchErr) errors.push(`touch: ${touchErr.message}`);

  // 3) Add the address to the workspace do-not-contact list (idempotent on the
  //    table's UNIQUE constraint) so re-enrollment also fails closed.
  const email = (lead.email || "").trim().toLowerCase();
  if (email.includes("@")) {
    const { error: supErr } = await supabase.from("campaign_suppression_list")
      .upsert(
        { workspace_id: lead.workspace_id, kind: "email", value: email },
        { onConflict: "workspace_id,kind,value", ignoreDuplicates: true },
      );
    if (supErr) errors.push(`suppression: ${supErr.message}`);
  }

  if (errors.length > 0) {
    console.error(`[outreach-unsubscribe] lead ${lead.id} (ws ${lead.workspace_id}) unsubscribe FAILED: ${errors.join("; ")}`);
    return page(
      "Something went wrong",
      "We couldn't process your unsubscribe just now. Please try again in a moment, or reply to the email with “unsubscribe” and we'll remove you.",
      500,
    );
  }

  console.log(`[outreach-unsubscribe] lead ${lead.id} (ws ${lead.workspace_id}) unsubscribed via ${req.method}`);
  return page("You're unsubscribed", "You won't receive any more emails from us. Sorry for the interruption.");
});
