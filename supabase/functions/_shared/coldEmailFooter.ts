// ============================================================================
// CAN-SPAM footer + List-Unsubscribe header for cold outreach (Unit C, PR 2)
//
// Every auto-sent or rep-approved COLD email must contain, by law:
//   (1) a working unsubscribe mechanism, and
//   (2) the sender's physical postal address.
// Both go in the BODY (the legally-required, provider-independent mechanism).
// The List-Unsubscribe header is an additional one-click affordance for email
// clients (RFC 8058) — added for Gmail (reliable); Microsoft Graph restricts
// custom internet headers, so Outlook relies on the body link. The body link +
// postal address is the floor and is present for BOTH providers.
//
// Header values are sanitized of CR/LF to prevent header injection.
// ============================================================================

export interface ColdFooter {
  /** Appended to the plain-text email body. */
  footerText: string;
  /** Email headers to attach where the provider supports them (Gmail). */
  headers: Record<string, string>;
}

/** Strip CR/LF (and trim) so a value can never break out of its header line. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Build the cold-email footer + headers.
 *  - unsubscribeUrl: the tokenized, public one-click link (never a raw lead id).
 *  - postalAddress: the workspace's user-entered company mailing address.
 * The caller is responsible for refusing to send when postalAddress is blank —
 * this builder assumes both inputs are present (it asserts non-empty to fail loud).
 */
export function buildColdEmailFooter(opts: { unsubscribeUrl: string; postalAddress: string }): ColdFooter {
  const url = sanitizeHeaderValue(opts.unsubscribeUrl);
  const postal = opts.postalAddress.trim();
  if (!url) throw new Error("buildColdEmailFooter: unsubscribeUrl is required");
  if (!postal) throw new Error("buildColdEmailFooter: postalAddress is required (CAN-SPAM)");

  // Plain-text footer. The "---" separator renders as an <hr> via plainTextToHtml.
  const footerText =
    `\n\n---\n` +
    `Don't want to hear from us? Unsubscribe here: ${url}\n\n` +
    postal;

  // RFC 2369 / RFC 8058 one-click. List-Unsubscribe-Post enables true one-click.
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List=One-Click",
  };

  return { footerText, headers };
}
