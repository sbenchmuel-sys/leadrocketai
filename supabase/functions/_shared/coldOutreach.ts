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

  // Prefer the lead's industry variant (case-insensitive — "Healthcare" must match a
  // "healthcare" lead), then the General/NULL variant. Do NOT fall back to an arbitrary
  // first row: that would send industry-specific copy to the wrong industry (e.g. only
  // the Healthcare variant is generated and a Finance lead gets it). Return null instead
  // so the caller defers (auto path) / shows no-content (review) rather than mis-targeting.
  const industry = (leadIndustry || "").trim().toLowerCase();
  const match =
    (industry && all.find((r) => (r.variant_group || "").trim().toLowerCase() === industry)) ||
    all.find((r) => !(r.variant_group || "").trim()) ||
    null;
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
  supabase: ServiceClient; // service-role client (floor checks + Gmail sender-mailbox check)
  supabaseUrl: string;
  serviceKey: string;
  internalSecret: string;
  lead: { id: string; email: string; owner_user_id: string };
  workspaceId: string;
  mailProvider: "gmail" | "outlook";
  mailAccountId?: string | null;
  subject: string;
  body: string;
  unsubscribeUrl: string;
}

export interface SendColdEmailResult {
  ok: boolean;
  messageId?: string | null;
  reason?: string;
  needsReconnect?: boolean;
}

/**
 * Send ONE cold email through the existing provider path with the CAN-SPAM footer
 * appended and (Gmail) the List-Unsubscribe header.
 *
 * The FAIL-CLOSED FLOOR lives HERE, inside the single sender, so it is
 * structurally impossible for ANY caller — the executor's automatic path,
 * PR 3's review-mode "Send" / manual "Sent it", or any future path — to email a
 * suppressed or unsubscribed lead, or to send a cold email with no physical
 * postal address:
 *   1. coldSendFloor (suppression list + leads.unsubscribed), and
 *   2. the company postal address, read from the workspace HERE (not trusted from
 *      the caller) and required non-blank (CAN-SPAM).
 * Callers should keep their own pre-checks too (defense in depth), but this is the
 * last line that cannot be bypassed. Returns { ok:false, reason } instead of
 * sending when the floor blocks.
 */
export async function sendColdEmailTouch(args: SendColdEmailArgs): Promise<SendColdEmailResult> {
  // (1) opt-out / suppression — fail closed.
  const floor = await coldSendFloor(args.supabase, args.lead.id, args.workspaceId);
  if (!floor.ok) return { ok: false, reason: floor.reason || "blocked by send floor" };

  // (2) CAN-SPAM postal address — read from the workspace, required non-blank.
  const { data: ws } = await args.supabase
    .from("workspaces")
    .select("cold_outreach_postal_address")
    .eq("id", args.workspaceId)
    .maybeSingle();
  const postalAddress = (ws?.cold_outreach_postal_address || "").trim();
  if (!postalAddress) return { ok: false, reason: "no company postal address (CAN-SPAM)" };

  const footer = buildColdEmailFooter({ unsubscribeUrl: args.unsubscribeUrl, postalAddress });
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
    // gmail-send resolves credentials from the owner's gmail_connections (it is
    // gmail_connections-based by ownerUserId, like the legacy executor — it does
    // NOT accept a mail_account_id). So verify the selected mail_accounts row
    // matches the owner's connected Gmail; never send from an unexpected mailbox.
    // Fail closed if the owner has no Gmail connection (gmail-send would error
    // "disconnected" anyway) or the selected account diverges from it.
    const { data: gconn } = await args.supabase
      .from("gmail_connections").select("gmail_email").eq("user_id", args.lead.owner_user_id).maybeSingle();
    if (!gconn?.gmail_email) {
      return { ok: false, reason: "sender's Gmail is not connected", needsReconnect: true };
    }
    if (args.mailAccountId) {
      const { data: macct } = await args.supabase
        .from("mail_accounts").select("email_address").eq("id", args.mailAccountId).maybeSingle();
      if (macct?.email_address && String(macct.email_address).toLowerCase() !== String(gconn.gmail_email).toLowerCase()) {
        return { ok: false, reason: "selected mailbox does not match the connected Gmail account" };
      }
    }
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

  // Read the next touch BEFORE exposing the cursor. The cursor advance is deliberately
  // LAST: a touch becomes "ready" only when step_number === current_step_number + 1, so
  // if we promoted the cursor first (as before) there would be a window where the next
  // touch is ready but still carries its OLD, possibly-already-due eligible_at — and a
  // concurrent executor/scheduler run could send/process it immediately, bypassing the
  // cadence spacing. Re-anchoring it into the future first, then advancing the cursor,
  // closes that window.
  const { data: next } = await supabase
    .from("campaign_touch")
    .select("id, step_number, eligible_at, max_age_at")
    .eq("enrollment_id", touch.enrollment_id)
    .eq("step_number", touch.step_number + 1)
    .maybeSingle();

  if (!next) {
    // No more touches — advance the cursor and complete the enrollment together.
    await supabase
      .from("campaign_enrollment")
      .update({ current_step_number: touch.step_number, status: "completed" })
      .eq("id", touch.enrollment_id);
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
  const update: Record<string, unknown> = { eligible_at: nextEligible.toISOString() };
  // Re-anchor the next touch's auto-skip deadline to the NEW eligibility, preserving
  // its original window. max_age_at was stamped at enrollment relative to the ORIGINAL
  // eligible_at; if a prior touch completed late, that old deadline can already be in
  // the past, so the scheduler would see max_age_at < now the instant the re-anchored
  // touch becomes due and auto-skip the (manual) step WITHOUT ever surfacing the card
  // to the rep. Shift the deadline by the same eligible→max-age delta. Email touches
  // (max_age_at null) keep null.
  if (next.max_age_at && next.eligible_at) {
    const windowMs = new Date(next.max_age_at).getTime() - new Date(next.eligible_at).getTime();
    if (windowMs > 0) update.max_age_at = new Date(nextEligible.getTime() + windowMs).toISOString();
  }
  await supabase.from("campaign_touch").update(update).eq("id", next.id);

  // ONLY NOW expose the cursor — the next touch is already correctly timed, so it
  // can't be picked up early.
  await supabase
    .from("campaign_enrollment")
    .update({ current_step_number: touch.step_number, status: "active" })
    .eq("id", touch.enrollment_id);
}

/**
 * End a cold enrollment: move it to a TERMINAL state AND clear its still-pending
 * touches. The scheduler's and executor's due queries filter ONLY on
 * campaign_touch.status / eligible_at (not on enrollment status), so a terminal
 * enrollment that leaves a 'scheduled' (or 'queued') touch behind would have that
 * dead row re-selected and skipped on every run — and once enough accumulate at the
 * oldest-due front they starve legitimate live touches (the 50/200-row batch caps).
 * Marking the pending touches 'skipped' removes them from those queries for good.
 * Use this for EVERY terminal exit: replied, unsubscribed/stopped, floor-blocked.
 */
export async function endColdEnrollment(
  supabase: ServiceClient,
  enrollmentId: string,
  status: "replied" | "stopped" | "completed",
): Promise<void> {
  await supabase.from("campaign_enrollment").update({ status }).eq("id", enrollmentId);
  await supabase
    .from("campaign_touch")
    .update({ status: "skipped" })
    .eq("enrollment_id", enrollmentId)
    .in("status", ["scheduled", "queued"]);
}

/** The public unsubscribe URL carrying the signed token. */
export function buildUnsubscribeUrl(supabaseUrl: string, token: string): string {
  return `${supabaseUrl}/functions/v1/outreach-unsubscribe?token=${encodeURIComponent(token)}`;
}
