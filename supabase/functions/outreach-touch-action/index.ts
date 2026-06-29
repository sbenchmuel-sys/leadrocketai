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
  repliedSinceEnrollment,
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

  // Load the lead and enforce workspace-match + OWNERSHIP before ANY action — incl.
  // set_call_outcome. The membership check above only proves the caller is in the
  // campaign's workspace; the review-send path sends FROM the lead owner's mailbox and
  // every advancing action drives the OWNER's cadence, and even set_call_outcome
  // mutates touch state that shapes later drafts — so a non-owner member must be kept
  // out of all of them. Require the lead owner OR a workspace admin (mirrors the leads
  // table's own owner-or-admin RLS). Internal/service callers (isPrivileged) are
  // trusted — they run the scheduler/executor as service_role.
  const { data: lead } = await admin
    .from("leads")
    .select("id, name, email, owner_user_id, workspace_id, industry, unsubscribed, last_inbound_at")
    .eq("id", touch.lead_id)
    .maybeSingle();
  if (!lead) return json({ ok: false, error: "Lead not found" }, 404);
  // Confirm the lead lives in the CAMPAIGN's workspace before acting on it with the
  // service-role client (a touch row tying a cross-workspace lead must not be
  // actionable). Enrollment RLS already prevents this, but fail closed here too.
  if (lead.workspace_id !== camp.workspace_id) return json({ ok: false, error: "Forbidden" }, 403);
  if (!auth.isPrivileged && lead.owner_user_id !== auth.userId) {
    const { data: isAdmin } = await admin.rpc("is_workspace_admin", {
      _workspace_id: camp.workspace_id,
      _user_id: auth.userId!,
    });
    if (!isAdmin) return json({ ok: false, error: "Only the lead owner can act on this outreach." }, 403);
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

  // REPLY BRIDGE (backstop): a lead can reply AFTER a touch is already queued —
  // the scheduler's reply bridge only runs while touches are 'scheduled'. So
  // re-check reply state here before sending/advancing: if the enrollment is
  // already 'replied', or a fresh inbound landed after the lead was committed to the
  // cadence (enrolled_at — NOT the possibly-future staggered started_at), pull the
  // lead out of the cold cadence instead of sending/advancing. The reply is
  // handled in the normal Queue (Follow up) via the existing pause-on-inbound path.
  const { data: enr } = await admin
    .from("campaign_enrollment")
    .select("id, status, started_at, enrolled_at")
    .eq("id", touch.enrollment_id)
    .maybeSingle();
  const replied =
    enr?.status === "replied" ||
    repliedSinceEnrollment(lead.last_inbound_at, enr?.enrolled_at);
  if (replied) {
    if (enr && enr.status !== "replied") {
      await admin.from("campaign_enrollment").update({ status: "replied" }).eq("id", enr.id);
    }
    // Clear ALL the enrollment's pending touches (not just this card): the workers
    // query campaign_touch by status BEFORE checking enrollment status, so future
    // 'scheduled' touches of a now-replied enrollment would linger and occupy the
    // capped batch. The reply itself is handled in the normal Queue (Follow up).
    await admin.from("campaign_touch").update({ status: "skipped" })
      .eq("enrollment_id", touch.enrollment_id).in("status", ["scheduled", "queued"]);
    return json({ ok: false, error: "This lead replied — handle it in your Queue.", replied: true }, 409);
  }

  // The enrollment must still be LIVE. If it was stopped (e.g. unsubscribe/bounce
  // marked the enrollment stopped but left a queued touch behind) or completed,
  // clear the stranded card and refuse — never send/advance a dead enrollment.
  if (enr && !["scheduled", "active"].includes(enr.status)) {
    await admin.from("campaign_touch").update({ status: "skipped" })
      .eq("enrollment_id", touch.enrollment_id).in("status", ["scheduled", "queued"]);
    return json({ ok: false, error: "This outreach is no longer active for this lead.", inactive: true }, 409);
  }

  // OPT-OUT BACKSTOP (ALL actions): an unsubscribe is a FULL stop — not just for
  // email. A lead can opt out after ANY touch (email or manual) is already queued, so
  // this guard must run before every action branch, not only the email sender. Without
  // it, mark_sent on a manual touch would still advance an opted-out lead's cadence.
  // Clear the card and stop the enrollment, mirroring the replied / inactive backstops.
  if (lead.unsubscribed) {
    if (enr && ["scheduled", "active"].includes(enr.status)) {
      await admin.from("campaign_enrollment").update({ status: "stopped" }).eq("id", touch.enrollment_id);
    }
    // Clear ALL the enrollment's pending touches, not just this card (see reply backstop).
    await admin.from("campaign_touch").update({ status: "skipped" })
      .eq("enrollment_id", touch.enrollment_id).in("status", ["scheduled", "queued"]);
    return json({ ok: false, error: "This lead opted out — removed from outreach.", optedOut: true }, 409);
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
    // (Unsubscribe is already handled by the opt-out backstop above — by here the lead
    // has NOT opted out.) A lead can still LOSE a valid email address while keeping the
    // rest of the cadence reachable via manual channels (call/SMS/WhatsApp/LinkedIn). So
    // don't just skip-and-stall this email card: ADVANCE the cadence past it (claim +
    // advanceColdEnrollment, exactly like mark_skipped) so the next touch gets scheduled.
    if (!lead.email) {
      if (!(await claimTouch("skipped"))) return json({ ok: true, alreadyHandled: true });
      await advanceColdEnrollment(admin, exec, touch, "skipped");
      return json({ ok: false, error: "This lead has no email address — skipped to the next step.", skipped: true }, 409);
    }

    // Resolve content + sender + secret BEFORE claiming, so a validation failure
    // never leaves the touch claimed.
    let subject = (payload.subject || "").trim();
    let body = (payload.body || "").trim();
    if (!subject || !body) {
      const firstName = (lead.name || "").split(" ")[0] || "there";
      const content = await resolveTouchContent(admin, camp.id, touch.step_number, lead.industry, firstName, lead.owner_user_id);
      if (!content) return json({ ok: false, error: "No content to send for this touch" }, 400);
      subject = subject || content.subject;
      body = body || content.body;
    }

    // Sender: require the LEAD OWNER's OWN connected mailbox (user_id = owner). The
    // cold model is owner-centric end to end — gmail-send sends from the owner's
    // gmail_connections and the per-mailbox daily cap is counted per owner — so the
    // sending mailbox MUST be the owner's. Selecting by workspace+is_default (or a
    // shared/coworker row) would send a rep's cold email from someone else's identity,
    // and a shared row can't even route correctly (Gmail requires the selected account
    // to match the owner's Gmail). If the owner has no own connected mailbox, refuse —
    // never impersonate, never fall back to legacy gmail_connections. Mirrors the
    // automatic executor path.
    const { data: mailAcct } = await admin
      .from("mail_accounts")
      .select("id, provider")
      .eq("workspace_id", lead.workspace_id)
      .eq("status", "connected")
      .eq("user_id", lead.owner_user_id)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!mailAcct) return json({ ok: false, error: "No connected mailbox to send from for this lead's owner" }, 400);

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
        campaignId: camp.id, leadIndustry: lead.industry,
      });
    } catch (err) {
      // A THROWN error (e.g. transient network failure invoking the provider) must
      // also release the claim — otherwise the touch is stuck 'sent' with no email
      // delivered and no way to retry. Return it to the Queue.
      await admin.from("campaign_touch").update({ status: "queued" }).eq("id", touch.id);
      return json({ ok: false, error: err instanceof Error ? err.message : "Send failed" }, 502);
    }
    if (!sendRes.ok) {
      const reason = sendRes.reason || "Send failed";
      // TERMINAL floor blocks mean this lead/address can NEVER be emailed — re-queuing
      // would loop the card forever and keep it consuming the capped Outreach queue with
      // repeated send failures. Treat them like a stopped enrollment: stop it and clear
      // its pending touches (mirrors the opt-out backstop). Covers opt-out / do-not-
      // contact AND a malformed/missing address (the floor's isSendableColdEmail rejects
      // an address edited into an invalid shape after enrollment). Other failures
      // (provider error, missing workspace postal address, transient floor read errors)
      // are retryable, so release the claim.
      const TERMINAL_REASONS = ["suppressed", "lead unsubscribed", "invalid email", "no email"];
      if (TERMINAL_REASONS.includes(reason)) {
        await admin.from("campaign_enrollment").update({ status: "stopped" }).eq("id", touch.enrollment_id);
        // This touch was optimistically claimed 'sent' above, but the send was blocked
        // and NOTHING was delivered — reset just this row to 'skipped' so it isn't counted
        // as a real send (the bulk skip below only catches still-scheduled/queued rows, so
        // without this the never-delivered touch stays 'sent' and inflates sent metrics +
        // the audit trail). Scope to touch.id so genuinely-sent prior touches stay 'sent'.
        await admin.from("campaign_touch").update({ status: "skipped" }).eq("id", touch.id);
        await admin.from("campaign_touch").update({ status: "skipped" })
          .eq("enrollment_id", touch.enrollment_id).in("status", ["scheduled", "queued"]);
        return json({ ok: false, error: "This lead can't be emailed (opted out, do-not-contact, or no valid address) — removed from outreach.", optedOut: true }, 409);
      }
      // Retryable — release the claim so the rep can try again from the Queue.
      await admin.from("campaign_touch").update({ status: "queued" }).eq("id", touch.id);
      return json({ ok: false, error: reason }, 400);
    }

    await advanceColdEnrollment(admin, exec, touch, "sent");
    return json({ ok: true, messageId: sendRes.messageId ?? null });
  }

  return json({ ok: false, error: `Unknown action: ${action}` }, 400);
});
