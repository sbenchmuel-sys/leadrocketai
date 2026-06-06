// ============================================================================
// Cold outreach send + cadence advance (Outreach Unit C, PR 2)
//
// The ONE place a cold campaign email is sent and the ONE place a cold cadence
// advances. Called by:
//   - automation-executor  → AUTOMATIC mode (auto-send the due email touch)
//   - campaign-touch-scheduler → auto-skip a stale/unreachable manual touch
//   - (PR 3) the Outreach UI → review-mode "Send" and manual "Sent it" / skip
//
// sendColdEmailTouch enforces the FAIL-CLOSED floor on EVERY send (automatic AND
// rep-approved): suppression list + leads.unsubscribed + postal-address-present.
// It funnels through the existing gmail-send / outlook-send provider path and
// adds the CAN-SPAM footer (+ List-Unsubscribe header on Gmail). It writes NO new
// sender and bypasses no provider guardrail. The caller is responsible for the
// AUTOMATIC-only guardrails (send window / min-gap / caps / daily cap / consent /
// cold_auto_send gate) — those do not apply to a rep-approved review send.
// ============================================================================

import { computeNextEligibleAt, type ExecutionSettings } from "./executionSettings.ts";
import { buildColdEmailFooter } from "./coldEmailFooter.ts";
import { plainTextToHtml } from "./emailUtils.ts";

type ServiceClient = any; // supabase-js client (service role)

// ── Content resolution (reuse Unit B's generated, rep-reviewed copy) ──────────

export interface TouchContent {
  subject: string;
  body: string;
}

/**
 * Resolve the email subject/body for a (campaign, step) and a lead's industry,
 * from campaign_step_content (Unit B). Picks the industry variant, falling back
 * to the General/NULL variant. Interpolates the lead's first name. Returns null
 * if no content exists (caller logs + skips that touch rather than sending blank).
 */
export async function resolveTouchContent(
  supabase: ServiceClient,
  campaignId: string,
  stepNumber: number,
  leadIndustry: string | null,
  leadFirstName: string,
): Promise<TouchContent | null> {
  const { data: rows } = await supabase
    .from("campaign_step_content")
    .select("subject, body, variant_group")
    .eq("campaign_id", campaignId)
    .eq("step_number", stepNumber);
  const all = (rows || []) as Array<{ subject: string | null; body: string | null; variant_group: string | null }>;
  if (all.length === 0) return null;

  const industry = (leadIndustry || "").trim();
  const match =
    (industry && all.find((r) => (r.variant_group || "") === industry)) ||
    all.find((r) => !r.variant_group) ||
    all[0];
  if (!match || !match.body) return null;

  const first = (leadFirstName || "there").trim() || "there";
  const interpolate = (s: string) =>
    s
      .replace(/\{first[_\s]*name\}/gi, first)
      .replace(/\[first[_\s]*name\]/gi, first)
      .replace(/\{name\}/gi, first)
      .replace(/\[name\]/gi, first);

  return {
    subject: interpolate(match.subject || `Following up, ${first}`),
    body: interpolate(match.body),
  };
}

// ── Fail-closed floor (runs on EVERY cold send, automatic and review) ─────────

export interface FloorResult {
  ok: boolean;
  reason?: string;
}

/**
 * The mandatory floor: never send to an opted-out or suppressed lead. Re-reads
 * leads.unsubscribed fresh (detectBounce sets it on a bounce, so this also closes
 * the bounce-stop) and checks the workspace do-not-contact list by exact email
 * and by domain. Fails CLOSED — any uncertainty returns ok:false.
 */
export async function coldSendFloor(
  supabase: ServiceClient,
  leadId: string,
  workspaceId: string,
): Promise<FloorResult> {
  const { data: lead, error } = await supabase
    .from("leads")
    .select("email, unsubscribed")
    .eq("id", leadId)
    .maybeSingle();
  if (error || !lead) return { ok: false, reason: "lead lookup failed" };
  if (lead.unsubscribed) return { ok: false, reason: "lead unsubscribed" };
  const email = (lead.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return { ok: false, reason: "no email" };

  const domain = email.split("@")[1] || "";
  // Parameter-safe (no interpolation into the filter string): fetch any rows whose
  // value matches the email OR the domain, then disambiguate by kind in JS.
  const { data: sup, error: supErr } = await supabase
    .from("campaign_suppression_list")
    .select("kind, value")
    .eq("workspace_id", workspaceId)
    .in("value", [email, domain]);
  if (supErr) return { ok: false, reason: "suppression check failed" }; // fail closed
  const hit = (sup || []).some(
    (r: { kind: string; value: string }) =>
      (r.kind === "email" && r.value === email) || (r.kind === "domain" && r.value === domain),
  );
  if (hit) return { ok: false, reason: "suppressed" };

  return { ok: true };
}

// ── The single cold-email sender ──────────────────────────────────────────────

export interface SendColdEmailArgs {
  supabaseUrl: string;
  serviceKey: string;
  internalSecret: string;
  lead: { id: string; email: string; owner_user_id: string };
  mailProvider: "gmail" | "outlook";
  mailAccountId?: string | null;
  subject: string;
  body: string;
  unsubscribeUrl: string;
  postalAddress: string;
}

export interface SendColdEmailResult {
  ok: boolean;
  messageId?: string | null;
  reason?: string;
  needsReconnect?: boolean;
}

/**
 * Send ONE cold email through the existing provider path with the CAN-SPAM footer
 * appended and (Gmail) the List-Unsubscribe header. Throws if postalAddress is
 * blank — the caller MUST have verified it (a cold email with no physical address
 * is a CAN-SPAM violation). Returns { ok } based on the provider's JSON result.
 */
export async function sendColdEmailTouch(args: SendColdEmailArgs): Promise<SendColdEmailResult> {
  const footer = buildColdEmailFooter({ unsubscribeUrl: args.unsubscribeUrl, postalAddress: args.postalAddress });
  const bodyWithFooter = args.body + footer.footerText;

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${args.serviceKey}`,
    "X-Internal-Secret": args.internalSecret,
  };

  let resp: Response;
  if (args.mailProvider === "outlook" && args.mailAccountId) {
    // Microsoft Graph restricts custom internet headers (must be x-*), so the
    // List-Unsubscribe header is omitted for Outlook — the body link + postal
    // address (always present) are the CAN-SPAM mechanism.
    resp = await fetch(`${args.supabaseUrl}/functions/v1/outlook-send`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        mail_account_id: args.mailAccountId,
        to: args.lead.email,
        subject: args.subject,
        bodyHtml: plainTextToHtml(bodyWithFooter),
        leadId: args.lead.id,
        ownerUserId: args.lead.owner_user_id,
        skipStateUpdate: true,
      }),
    });
  } else {
    resp = await fetch(`${args.supabaseUrl}/functions/v1/gmail-send`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        to: args.lead.email,
        subject: args.subject,
        body: bodyWithFooter,
        headers: footer.headers, // List-Unsubscribe (+ One-Click)
        leadId: args.lead.id,
        ownerUserId: args.lead.owner_user_id,
        skipStateUpdate: true,
      }),
    });
  }

  // Providers always return HTTP 200 with a JSON { ok } body.
  const result = await resp.json().catch(() => ({ ok: false, error: "bad provider response" }));
  if (!result.ok) {
    return { ok: false, reason: String(result.error || "send failed"), needsReconnect: !!result.needsReconnect };
  }
  return { ok: true, messageId: result.messageId || result.messageSid || null };
}

// ── Cadence advance (the shared advance for every completion path) ────────────

export type TouchCompletion = "sent" | "skipped" | "auto_skipped";

/**
 * Mark a touch complete and arm the NEXT touch. Advancing in lock-step with
 * enrollment.current_step_number guarantees only the (current+1) touch is ever
 * "ready", so out-of-order firing is impossible even though all touch rows were
 * pre-created at enrollment. The next touch's eligible_at is re-anchored to
 * (completion time + the next step's gap), so a late completion pushes the next
 * touch out — "each completed touch schedules the next by the cadence spacing".
 */
export async function advanceColdEnrollment(
  supabase: ServiceClient,
  execSettings: ExecutionSettings,
  touch: { id: string; enrollment_id: string; campaign_id: string; lead_id: string; step_number: number },
  completion: TouchCompletion,
  opts?: { automationLogId?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = { status: completion };
  if (completion === "sent") {
    patch.sent_at = new Date().toISOString();
    if (opts?.automationLogId) patch.automation_log_id = opts.automationLogId;
  }
  await supabase.from("campaign_touch").update(patch).eq("id", touch.id);

  // Promote the enrollment's cursor to this step (and keep it active while there
  // are more touches; the no-next branch below flips it to 'completed').
  await supabase
    .from("campaign_enrollment")
    .update({ current_step_number: touch.step_number, status: "active" })
    .eq("id", touch.enrollment_id);

  // Arm the next touch, or complete the enrollment.
  const { data: next } = await supabase
    .from("campaign_touch")
    .select("id, step_number")
    .eq("enrollment_id", touch.enrollment_id)
    .eq("step_number", touch.step_number + 1)
    .maybeSingle();

  if (!next) {
    await supabase.from("campaign_enrollment").update({ status: "completed" }).eq("id", touch.enrollment_id);
    return;
  }

  // Gap for the next step = its campaign_steps.delay_days (business-day gap).
  const { data: step } = await supabase
    .from("campaign_steps")
    .select("delay_days")
    .eq("campaign_id", touch.campaign_id)
    .eq("step_number", next.step_number)
    .maybeSingle();
  const gap = typeof step?.delay_days === "number" ? step.delay_days : 2;

  // computeNextEligibleAt snaps to the workspace send window + business hours +
  // jitter (recipient-timezone refinement lands in PR 4).
  const nextEligible = computeNextEligibleAt(gap, touch.lead_id, `cold_touch_${next.id}`, execSettings);
  await supabase
    .from("campaign_touch")
    .update({ eligible_at: nextEligible.toISOString() })
    .eq("id", next.id);
}

/** The public unsubscribe URL carrying the signed token. */
export function buildUnsubscribeUrl(supabaseUrl: string, token: string): string {
  return `${supabaseUrl}/functions/v1/outreach-unsubscribe?token=${encodeURIComponent(token)}`;
}
