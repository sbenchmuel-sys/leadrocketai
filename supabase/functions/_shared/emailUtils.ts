/**
 * Extracts every email address from an RFC 2822 header value such as
 *   "Stuart Mills <stuart@acme.com>, bob@acme.com, \"Lisa\" <lisa@acme.com>"
 *
 * Returns lowercase, trimmed addresses. Used by sync paths to populate the
 * full to_emails / cc_emails arrays on interactions.
 */
export function extractEmailsFromHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  const results: string[] = [];
  const re = /<([^>]+@[^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    const addr = (m[1] || m[2]).toLowerCase().trim();
    if (addr) results.push(addr);
  }
  // De-duplicate while preserving order
  return Array.from(new Set(results));
}

/**
 * Converts AI-generated plain text (with \n\n paragraph separators) to clean HTML.
 *
 * Used to produce the HTML body for both Gmail (multipart/alternative) and
 * Outlook (Graph API contentType:"HTML") sends. Ensures paragraph spacing and
 * line breaks render correctly on all clients: iOS Mail, Gmail web, Outlook,
 * Apple Mail, and plain-text fallbacks.
 */
export function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const paragraphs = escaped.split(/\n\n+/).map(p => {
    const trimmed = p.trim();
    if (!trimmed) return "";
    // Render the unsubscribe separator as a light horizontal rule
    if (trimmed === "---") {
      return `<hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0">`;
    }
    return `<p style="margin:0 0 1em 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">${trimmed.replace(/\n/g, "<br>")}</p>`;
  });

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px">${paragraphs.filter(Boolean).join("\n")}</body></html>`;
}
