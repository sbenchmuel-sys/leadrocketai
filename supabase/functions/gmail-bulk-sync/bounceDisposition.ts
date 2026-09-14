// ============================================================
// bounceDisposition — what gmail-bulk-sync should DO with a message
// that looks like a delivery-failure report.
//
// Pure: the whole decision, with no Supabase client and no I/O, so it
// has a runnable test (bounceDisposition.test.ts). Both of bulk-sync's
// message loops (newest-page and thread-expansion) call it, so they
// cannot drift apart.
//
// The two defects this replaces (Unit G-B P1):
//   1. ANY DSN-ish keyword set `leads.unsubscribed = true`. A SOFT bounce
//      (mailbox full, greylisting, a temporary defer) therefore opted a
//      real, reachable customer out of ALL future contact, permanently.
//   2. The DSN then fell through to the normal insert. It comes FROM
//      postmaster, so the "is it from the lead?" direction test said no
//      and it was stored as `email_outbound` — a fake sent email that
//      corrupted last_outbound_at and every outbound counter.
// ============================================================

import { classifyBounce, detectBounce, dsnNamesRecipient } from "../_shared/bounceDetection.ts";

export type BounceDisposition =
  /** Not a delivery report at all — carry on with normal processing. */
  | "not_a_bounce"
  /** A DSN, but for some other recipient. Ignore it entirely. */
  | "not_about_lead"
  /** A DSN for this lead, but TRANSIENT. Record as seen; change nothing. */
  | "transient"
  /** A DSN for this lead, PERMANENT. Stop the lead. Never store as outbound. */
  | "hard_stop";

export interface BounceDispositionResult {
  disposition: BounceDisposition;
  /** RFC 3463 code that decided it, when there was one. */
  statusCode: string | null;
  /** How classifyBounce reached its verdict: "code" | "keyword" | "fallback". */
  basis: string | null;
}

/**
 * Decide what to do with one message.
 *
 * `deliveryStatusText` is the concatenated `message/delivery-status` MIME
 * part(s). Pass it: a standards-shaped multipart/report DSN names the failed
 * address and its status code ONLY there, so classifying off the human body
 * alone misses real hard bounces (they fall back to transient, and the lead is
 * never suppressed).
 *
 * `headersInvolveLead` is the caller's existing `messageInvolvesLead(headers,
 * leadEmail)` result — a DSN addressed directly to/from the lead.
 *
 * FAIL-SAFE DIRECTION (inherited from classifyBounce): when a bounce cannot be
 * classified we return "transient". Destroying a good lead is the expensive,
 * irreversible mistake; retrying a dead address is not.
 */
export function bounceDisposition(input: {
  fromEmail: string;
  subject: string;
  bodyText: string;
  deliveryStatusText: string;
  leadEmail: string;
  headersInvolveLead: boolean;
}): BounceDispositionResult {
  const none = { statusCode: null, basis: null };

  if (!detectBounce(input.fromEmail, input.subject).isBounce) {
    return { disposition: "not_a_bounce", ...none };
  }

  const lead = input.leadEmail.trim().toLowerCase();
  if (!lead) return { disposition: "not_about_lead", ...none };

  const aboutThisLead =
    input.headersInvolveLead ||
    input.bodyText.toLowerCase().includes(lead) ||
    dsnNamesRecipient(input.deliveryStatusText, lead);
  if (!aboutThisLead) return { disposition: "not_about_lead", ...none };

  const cls = classifyBounce({
    fromEmail: input.fromEmail,
    subject: input.subject,
    body: `${input.bodyText}\n\n${input.deliveryStatusText}`,
    recipientEmail: lead,
  });

  return {
    disposition: cls.severity === "hard" ? "hard_stop" : "transient",
    statusCode: cls.statusCode,
    basis: cls.basis,
  };
}
