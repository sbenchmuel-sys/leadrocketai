// ============================================================
// bounceDisposition — what a mail sync should DO with a message that
// looks like a delivery-failure report.
//
// Pure: the whole decision, with no Supabase client and no I/O, so a
// vitest spec can exercise the real function (src/test/bounceDisposition
// .test.ts) as well as the Deno mirror beside this file.
//
// Callers: gmail-bulk-sync (both of its message loops) and outlook-sync.
// One decision in one place — the duplicated inline copies drifting apart
// is what produced these defects in the first place.
// ponytail: gmail-sync still has its own inline copy; it is owned by
// another unit right now. Fold it in when that file is next in hand.
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

import { classifyBounce, detectBounce, dsnNamesRecipient } from "./bounceDetection.ts";
import { extractEmailsFromHeader } from "./emailUtils.ts";

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
  /**
   * Did this message pass the rep↔lead direct-conversation gate?
   * See NOT-A-BOUNCE GUARD below — this is the main thing standing between a
   * live customer and a permanent opt-out.
   */
  isDirectConversation: boolean;
}): BounceDispositionResult {
  const none = { statusCode: null, basis: null };
  const lead = input.leadEmail.trim().toLowerCase();

  const detected = detectBounce(input.fromEmail, input.subject);
  if (!detected.isBounce) return { disposition: "not_a_bounce", ...none };
  if (!lead) return { disposition: "not_about_lead", ...none };

  // ── NOT-A-BOUNCE GUARD ───────────────────────────────────────────────────
  // `detectBounce` fires on SUBJECT keywords as well as sender, and a human
  // forwarding a bounce keeps the DSN wording in the subject and the DSN's
  // status code in the quoted body. Without this guard:
  //
  //   From: Ann Smith <ann@acme.com>          (the lead — a live buyer)
  //   Subject: Fwd: Undeliverable: Your quote
  //   Body: "your mail to my colleague bounced, please resend to me"
  //         + forwarded report containing `Status: 5.1.1`
  //
  // classified as a HARD bounce: the customer was permanently unsubscribed,
  // their automation stopped, and — because every bounce branch ends in
  // `continue` — their message was never stored, so the rep never saw the
  // reply that asked them to resend. Wrong AND invisible.
  //
  // The structural fact that rules it out: a machine DSN is emitted by an MTA
  // (postmaster / MAILER-DAEMON) to the mailbox that sent the failed message.
  // It can never travel as a direct rep↔lead exchange, and it can never
  // originate from the lead's own mailbox. So:
  //
  //   (a) anything that passed the direct-conversation gate is human mail, and
  //   (b) anything whose From IS the lead's own address is human mail
  //
  // ...even when it is dressed in DSN wording. Both fall through to normal
  // storage instead of the bounce path.
  //
  // Carve-out: only when the subject is what tripped the detector. If the FROM
  // matched (`reason === "from"`, i.e. the sender itself looks like a
  // postmaster address), a genuine DSN is still possible — that is the
  // degenerate case of a lead whose own address is `postmaster@…` — and we
  // keep classifying it.
  if (detected.reason === "subject") {
    if (input.isDirectConversation) return { disposition: "not_a_bounce", ...none };
    const fromAddresses = extractEmailsFromHeader(input.fromEmail);
    if (fromAddresses.includes(lead)) return { disposition: "not_a_bounce", ...none };
  }

  // ── ATTRIBUTION ──────────────────────────────────────────────────────────
  // Whole-address matching only. A substring test (`body.includes(lead)`)
  // attributed a DSN for `joann@acme.com` to lead `ann@acme.com`, and one for
  // `no-reply-sales@acme.com` to lead `sales@acme.com` — stopping the wrong
  // lead. `dsnNamesRecipient` tokenises addresses out of the text and compares
  // them whole, so it is used for the human body as well as the machine part.
  const aboutThisLead =
    input.headersInvolveLead ||
    dsnNamesRecipient(input.bodyText, lead) ||
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
