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

  // The remaining actions ADVANCE the cadence — only valid on an ACTIVE outreach.
  // A paused/stopped outreach must never be advanced or sent manually (Pause must
  // mean stop). Paused campaigns are also filtered out of the Outreach list, so a
  // rep normally won't even see these; this is the server-side backstop.
  if (camp.status !== "active") return json({ ok: false, error: "Outreach is not active" }, 400);

  const { data: lead } = await admin
    .from("leads")
    .select("id, name, email, owner_user_id, workspace_id, industry, unsubscribed, last_inbound_at")
    .eq("id", touch.lead_id)
    .maybeSingle();
  if (!lead) return json({ ok: false, error: "Lead not found" }, 404);
  // Defense in depth: membership was checked against the CAMPAIGN's workspace, so
  // confirm the lead lives in that same workspace before acting on it with the
  // service-role client (a touch row tying a cross-workspace lead must not be
  // actionable). Enrollment RLS already prevents this, but fail closed here too.
  if (lead.workspace_id !== camp.workspace_id) return json({ ok: false, error: "Forbidden" }, 403);

  // REPLY BRIDGE (backstop): a lead can reply AFTER a touch is already queued —
  // the scheduler's reply bridge only runs while touches are 'scheduled'. So
  // re-check reply state here before sending/advancing: if the enrollment is
  // already 'replied', or a fresh inbound landed after the lead started, pull the
  // lead out of the cold cadence instead of sending/advancing. The reply is
  // handled in the normal Queue (Follow up) via the existing pause-on-inbound path.
  const { data: enr } = await admin
    .from("campaign_enrollment")
    .select("id, status, started_at")
    .eq("id", touch.enrollment_id)
    .maybeSingle();
  const replied =
    enr?.status === "replied" ||
    (!!lead.last_inbound_at && !!enr?.started_at && new Date(lead.last_inbound_at) > new Date(enr.started_at));
  if (replied) {
    if (enr && enr.status !== "replied") {
      await admin.from("campaign_enrollment").update({ status: "replied" }).eq("id", enr.id);
    }
    // Clear the surfaced card: mark the queued touch skipped so it leaves the
    // Outreach list (the fetch filters on status='queued'). Otherwise the card
    // would reappear forever and every action would hit this same 409. The reply
    // itself is handled in the normal Queue (Follow up).
    await admin.from("campaign_touch").update({ status: "skipped" }).eq("id", touch.id).eq("status", "queued");
    return json({ ok: false, error: "This lead replied — handle it in your Queue.", replied: true }, 409);
  }

  // The enrollment must still be LIVE. If it was stopped (e.g. unsubscribe/bounce
  // marked the enrollment stopped but left a queued touch behind) or completed,
  // clear the stranded card and refuse — never send/advance a dead enrollment.
  if (enr && !["scheduled", "active"].includes(enr.status)) {
    await admin.from("campaign_touch").update({ status: "skipped" }).eq("id", touch.id).eq("status", "queued");
    return json({ ok: false, error: "This outreach is no longer active for this lead.", inactive: true }, 409);
  }

  const exec = await loadExecutionSettings(lead.owner_user_id, admin);

  // Atomically CLAIM the queued touch: flip queued → <status> in ONE update guarded
  // on status='queued'. The DB guarantees only one concurrent request wins, so a
  // double-click / retry / two open tabs can never double-send or double-advance —
  // the loser matches 0 rows and bails. This is the race fix.
  const claimTouch = async (claimStatus: string): Promise<boolean> => {
    const { data } = await admin
      .from("campaign_touch")
      .update({ status: claimStatus })
      .eq("id", touch.id)
      .eq("status", "queued")
      .select("id");
    return (data || []).length > 0;
  };

  // ── mark_skipped: claim + advance ──
  if (action === "mark_skipped") {
    if (!(await claimTouch("skipped"))) return json({ ok: true, alreadyHandled: true });
    await advanceColdEnrollment(admin, exec, touch, "skipped");
    return json({ ok: true });
  }

  // ── mark_sent: rep sent via their own app (manual channels) — claim + advance ──
  if (action === "mark_sent") {
    // Manual channels ONLY. An email touch must go through send_review_email (which
    // actually delivers) — a buggy/malicious client must not be able to advance an
    // email touch as 'sent' without an email ever going out.
    if (touch.channel === "email") {
      return json({ ok: false, error: "Email touches must be sent, not marked sent." }, 400);
    }
    if (!(await claimTouch("sent"))) return json({ ok: true, alreadyHandled: true });
    await advanceColdEnrollment(admin, exec, touch, "sent");
    return json({ ok: true });
  }

  // ── send_review_email: send the rep-approved email through the one sender ──
  if (action === "send_review_email") {
    if (touch.channel !== "email") return json({ ok: false, error: "Not an email touch" }, 400);
    if (lead.unsubscribed || !lead.email) {
      // The lead opted out (or lost a valid address) AFTER this review card was
      // queued. The send floor would block it anyway — but returning 400 here without
      // touching the touch leaves the card stranded 'queued', so it reappears in the
      // Outreach tab forever and every "Send" re-hits this 400. Clear the card (and
      // stop the now-dead enrollment when unsubscribed) so the lead leaves the cadence,
      // mirroring the replied / inactive-enrollment backstops above.
      await admin.from("campaign_touch").update({ status: "skipped" }).eq("id", touch.id).eq("status", "queued");
      if (lead.unsubscribed && enr && ["scheduled", "active"].includes(enr.status)) {
        await admin.from("campaign_enrollment").update({ status: "stopped" }).eq("id", touch.enrollment_id);
      }
      return json(
        { ok: false, error: "This lead can't be emailed (opted out) — removed from outreach.", optedOut: true },
        409,
      );
    }

    // Resolve content + sender + secret BEFORE claiming, so a validation failure
    // never leaves the touch claimed.
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

    // CLAIM atomically right before sending — only the winner proceeds, so two
    // concurrent send_review_email requests can never deliver duplicate cold emails.
    if (!(await claimTouch("sent"))) return json({ ok: true, alreadyHandled: true });

    const token = await signUnsubscribeToken(
      { lid: lead.id, wid: lead.workspace_id, cid: camp.id, iat: Math.floor(Date.now() / 1000) }, unsubSecret);
    const unsubscribeUrl = buildUnsubscribeUrl(supabaseUrl, token);

    // The one sender — structural fail-closed floor (suppression + unsubscribed +
    // postal) runs INSIDE this call, so a review send can never reach an opted-out
    // or suppressed lead even though it skips the automatic pacing/cap guardrails.
    let sendRes;
    try {
      sendRes = await sendColdEmailTouch({
        supabase: admin, supabaseUrl, serviceKey, internalSecret: Deno.env.get("INTERNAL_API_SECRET") ?? "",
        lead: { id: lead.id, email: lead.email, owner_user_id: lead.owner_user_id },
        workspaceId: lead.workspace_id,
        mailProvider: mailAcct.provider as "gmail" | "outlook", mailAccountId: mailAcct.id,
        subject, body, unsubscribeUrl,
      });
    } catch (err) {
      // A THROWN error (e.g. transient network failure invoking the provider) must
      // also release the claim — otherwise the touch is stuck 'sent' with no email
      // delivered and no way to retry. Return it to the Queue.
      await admin.from("campaign_touch").update({ status: "queued" }).eq("id", touch.id);
      return json({ ok: false, error: err instanceof Error ? err.message : "Send failed" }, 502);
    }
    if (!sendRes.ok) {
      // Send returned a failure — release the claim so the rep can retry from the Queue.
      await admin.from("campaign_touch").update({ status: "queued" }).eq("id", touch.id);
      return json({ ok: false, error: sendRes.reason || "Send failed" }, 400);
    }

    await advanceColdEnrollment(admin, exec, touch, "sent");
    return json({ ok: true, messageId: sendRes.messageId ?? null });
  }

  return json({ ok: false, error: `Unknown action: ${action}` }, 400);
});
