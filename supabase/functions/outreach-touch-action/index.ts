// ============================================================================
// outreach-touch-action — rep actions on cold Outreach touches (Unit C, PR 3)
//
// The SINGLE authenticated entry point for the rep-driven side of the cold
// cadence. User-authenticated (verify_jwt=true + requireAuth) and workspace-scoped
// (assertWorkspaceMembership). Every send funnels through the shared
// sendColdEmailTouch (whose fail-closed floor — suppression + unsubscribed +
// postal address — is STRUCTURAL and cannot be bypassed) and every advance
// through advanceColdEnrollment. There is NO new send path here.
//
// Actions:
//   send_review_email — review-mode "Send": send the (rep-approved/edited) email
//                       and advance. Idempotent on double-click (touch must be queued).
//   mark_sent         — manual "Sent it": the rep sent via their own phone/app
//                       (call/SMS/WhatsApp/LinkedIn). No email is sent — just advance.
//   mark_skipped      — skip this touch and advance.
//   set_call_outcome  — record "got_them" / "no_answer" (shapes the next draft;
//                       does NOT advance — the rep still taps "Sent it").
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth, assertWorkspaceMembership } from "../_shared/authz.ts";
import { loadExecutionSettings } from "../_shared/executionSettings.ts";
import {
  resolveTouchContent,
  sendColdEmailTouch,
  advanceColdEnrollment,
  buildUnsubscribeUrl,
} from "../_shared/coldOutreach.ts";
import { signUnsubscribeToken, getUnsubscribeSecret } from "../_shared/outreachUnsubscribeToken.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await requireAuth(req, corsHeaders);
  if (auth instanceof Response) return auth;

  let payload: { action?: string; touchId?: string; subject?: string; body?: string; outcome?: string };
  try { payload = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const { action, touchId } = payload;
  if (!action || !touchId) return json({ ok: false, error: "action and touchId are required" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Load the touch + its campaign (for workspace scoping).
  const { data: touch } = await admin
    .from("campaign_touch")
    .select("id, enrollment_id, campaign_id, lead_id, step_number, channel, status")
    .eq("id", touchId)
    .maybeSingle();
  if (!touch) return json({ ok: false, error: "Touch not found" }, 404);

  const { data: camp } = await admin
    .from("campaigns")
    .select("id, status, workspace_id")
    .eq("id", touch.campaign_id)
    .maybeSingle();
  if (!camp) return json({ ok: false, error: "Outreach not found" }, 404);

  // Workspace membership (skip for internal/service callers).
  if (!auth.isPrivileged) {
    const member = await assertWorkspaceMembership(admin, camp.workspace_id, auth.userId!);
    if (!member.ok) return json({ ok: false, error: member.error || "Forbidden" }, member.status || 403);
  }

  // ── set_call_outcome: record the outcome only (no advance) ──
  if (action === "set_call_outcome") {
    const outcome = payload.outcome;
    if (outcome !== "got_them" && outcome !== "no_answer") return json({ ok: false, error: "Invalid outcome" }, 400);
    await admin.from("campaign_touch").update({ call_outcome: outcome }).eq("id", touch.id);
    return json({ ok: true });
  }

  // Remaining actions act on a touch that's still live (queued). Re-fetch the
  // status fresh to make double-clicks idempotent (no double-send / double-advance).
  const { data: fresh } = await admin.from("campaign_touch").select("status").eq("id", touch.id).maybeSingle();
  if (!fresh || fresh.status !== "queued") return json({ ok: true, alreadyHandled: true });

  const { data: lead } = await admin
    .from("leads")
    .select("id, name, email, owner_user_id, workspace_id, industry, unsubscribed")
    .eq("id", touch.lead_id)
    .maybeSingle();
  if (!lead) return json({ ok: false, error: "Lead not found" }, 404);

  const exec = await loadExecutionSettings(lead.owner_user_id, admin);

  // ── mark_skipped: skip + advance ──
  if (action === "mark_skipped") {
    await advanceColdEnrollment(admin, exec, touch, "skipped");
    return json({ ok: true });
  }

  // ── mark_sent: rep sent via their own app (manual channels) — advance only ──
  if (action === "mark_sent") {
    await advanceColdEnrollment(admin, exec, touch, "sent");
    return json({ ok: true });
  }

  // ── send_review_email: send the rep-approved email through the one sender ──
  if (action === "send_review_email") {
    if (touch.channel !== "email") return json({ ok: false, error: "Not an email touch" }, 400);
    if (camp.status !== "active") return json({ ok: false, error: "Outreach is not active" }, 400);
    if (lead.unsubscribed || !lead.email) return json({ ok: false, error: "Lead can't be emailed" }, 400);

    // Content: prefer the rep's edited subject/body; otherwise resolve the
    // generated copy for this step + the lead's industry.
    let subject = (payload.subject || "").trim();
    let body = (payload.body || "").trim();
    if (!subject || !body) {
      const firstName = (lead.name || "").split(" ")[0] || "there";
      const content = await resolveTouchContent(admin, camp.id, touch.step_number, lead.industry, firstName);
      if (!content) return json({ ok: false, error: "No content to send for this touch" }, 400);
      subject = subject || content.subject;
      body = body || content.body;
    }

    // Sender (same sender-mismatch guard as the executor: require a connected
    // mail_accounts row; never fall back).
    const { data: mailAcct } = await admin
      .from("mail_accounts")
      .select("id, provider")
      .eq("workspace_id", lead.workspace_id)
      .eq("status", "connected")
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!mailAcct) return json({ ok: false, error: "No connected mailbox to send from" }, 400);

    const unsubSecret = getUnsubscribeSecret();
    if (!unsubSecret) return json({ ok: false, error: "Unsubscribe is not configured" }, 500);
    const token = await signUnsubscribeToken(
      { lid: lead.id, wid: lead.workspace_id, cid: camp.id, iat: Math.floor(Date.now() / 1000) }, unsubSecret);
    const unsubscribeUrl = buildUnsubscribeUrl(supabaseUrl, token);

    // The one sender — structural fail-closed floor (suppression + unsubscribed +
    // postal) runs INSIDE this call, so a review send can never reach an opted-out
    // or suppressed lead even though it skips the automatic pacing/cap guardrails.
    const sendRes = await sendColdEmailTouch({
      supabase: admin, supabaseUrl, serviceKey, internalSecret: Deno.env.get("INTERNAL_API_SECRET") ?? "",
      lead: { id: lead.id, email: lead.email, owner_user_id: lead.owner_user_id },
      workspaceId: lead.workspace_id,
      mailProvider: mailAcct.provider as "gmail" | "outlook", mailAccountId: mailAcct.id,
      subject, body, unsubscribeUrl,
    });
    if (!sendRes.ok) return json({ ok: false, error: sendRes.reason || "Send failed" }, 400);

    await advanceColdEnrollment(admin, exec, touch, "sent");
    return json({ ok: true, messageId: sendRes.messageId ?? null });
  }

  return json({ ok: false, error: `Unknown action: ${action}` }, 400);
});
