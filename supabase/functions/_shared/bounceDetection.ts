/**
 * Shared bounce / NDR (non-delivery report) detection.
 *
 * Extracted from the inline copies in:
 *   - supabase/functions/gmail-sync/index.ts   (~lines 387–397)
 *   - supabase/functions/outlook-sync/index.ts (~lines 277–287)
 *
 * Logic is identical to both inline copies. Phase 2a will migrate
 * those callers to import from this module so there is a single
 * source of truth; until then the inline copies remain authoritative
 * for the live sync path and this module is consumed by the
 * `classify-timeline-intent-backfill` edge function only.
 *
 * Detects system-generated bounce messages from postmaster /
 * mailer-daemon / mail-delivery senders or by NDR subject lines.
 */

const BOUNCE_FROM_KEYWORDS = [
  "postmaster",
  "mailer-daemon",
  "mail delivery",
];

const BOUNCE_SUBJECT_KEYWORDS = [
  "delivery status notification",
  "undeliverable",
  "mail delivery failed",
  "returned mail",
  "failure notice",
  "delivery failure",
];

export interface BounceResult {
  isBounce: boolean;
  /** Which signal tripped: "from" (postmaster-style sender) or "subject". */
  reason: "from" | "subject" | null;
}

/**
 * Detect whether an email is a delivery-failure / bounce notification.
 * Pass the raw `From:` header value and the raw subject line.
 */
export function detectBounce(fromEmail: string, subject: string): BounceResult {
  const fromLower = (fromEmail || "").toLowerCase();
  const subjectLower = (subject || "").toLowerCase();

  if (BOUNCE_FROM_KEYWORDS.some((kw) => fromLower.includes(kw))) {
    return { isBounce: true, reason: "from" };
  }
  if (BOUNCE_SUBJECT_KEYWORDS.some((kw) => subjectLower.includes(kw))) {
    return { isBounce: true, reason: "subject" };
  }
  return { isBounce: false, reason: null };
}
