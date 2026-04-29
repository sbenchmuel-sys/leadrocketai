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
