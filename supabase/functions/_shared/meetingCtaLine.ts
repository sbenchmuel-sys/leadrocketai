// ============================================================================
// PER-REP MEETING CTA — send-time append (Outreach Unit 3)
//
// Cold campaign emails ship the workspace-SHARED campaign_step_content body
// (resolveTouchContent), so a rep's personal booking link must NEVER be baked
// into that stored content — it would leak one rep's link into another rep's
// send. Instead the link is appended HERE, at send time, from the LEAD OWNER's
// own rep_profiles.calendar_link. Pure + dependency-free so it's unit-testable.
// ============================================================================

/** The booking-CTA line appended to a cold email body when the step's meeting
 *  link is on. `link` is the SENDING rep's (lead owner's) own calendar link. */
export function buildMeetingCtaLine(link: string): string {
  return `P.S. If it's easier, grab a time that works for you here: ${link}`;
}

/**
 * Append the booking CTA to an email body, idempotently. Returns the body
 * unchanged when there's no link (no placeholder, no broken CTA) or when the
 * exact link is already present (so a re-resolve never double-appends). The CTA
 * goes on its own paragraph, before the CAN-SPAM footer the sender adds later.
 */
export function appendMeetingCta(body: string, link: string | null | undefined): string {
  const url = (link || "").trim();
  if (!url) return body;
  const base = (body || "").trimEnd();
  if (base.includes(url)) return base; // already there — don't duplicate
  return `${base}\n\n${buildMeetingCtaLine(url)}`;
}
