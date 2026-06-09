/**
 * Broadened human unsubscribe detection.
 *
 * Matches common opt-out phrases people actually type:
 *   "unsubscribe", "Unsubscribe", "stop sending", "stop emailing",
 *   "remove me", "please don't email", "opt out", "take me off",
 *   "no more emails", "please stop sending mails", etc.
 *
 * The caller is responsible for the List-Unsubscribe header guard
 * (newsletters should be excluded before calling this function).
 */
/**
 * Best-effort removal of quoted reply / forwarded history from a plain-text
 * email body, returning only the text the sender actually typed at the top.
 *
 * WHY THIS EXISTS: unsubscribe detection (and the callers below) run keyword
 * regexes over the whole body. Reply clients quote the prior thread, so our own
 * outbound copy — e.g. a pitch line containing "stop emailing" — would get
 * matched as if the lead asked to opt out. (Real incident: a promoted lead was
 * wrongly flagged unsubscribed because our quoted pitch said "…so you stop
 * emailing people who already wrote back".) Stripping the quote first removes
 * that whole class of false positives.
 *
 * NOTE on input: callers feed plain text produced by getMessageBody /
 * htmlToPlainText. HTML→text conversion discards <blockquote> and ">" prefixes,
 * so we cannot rely on ">"-quoting alone — we key off attribution lines
 * ("On … wrote:"), Outlook "Original Message" separators, and the From:/Sent:/
 * To:/Subject: header block that precedes quoted Outlook history.
 *
 * SAFETY DIRECTION: this is a guardrail. A false unsubscribe silently kills a
 * lead's automation; a missed one just leaves a visible inbound for the rep to
 * handle. So we err toward stripping: if the sender typed nothing above the
 * quote, we return "" (no new text → no opt-out), never the original body.
 */
export function stripQuotedReply(body: string): string {
  if (!body) return body;
  const text = body.replace(/\r\n/g, "\n");

  const markers: RegExp[] = [
    // Gmail / Apple Mail attribution: "On <date>, <name> wrote:" (may wrap lines)
    /^[ \t]*On\b[\s\S]{0,300}?\bwrote:[ \t]*$/im,
    // Outlook / generic "-----Original Message-----" separator
    /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
    // Outlook reply header block: From: followed by Sent/Date/To/Cc/Subject lines
    /^[ \t]*From:[ \t].*\n(?:[ \t]*(?:Sent|Date|To|Cc|Subject):[ \t].*\n?)+/im,
    // Underscore divider Outlook inserts before the quoted header
    /^_{5,}[ \t]*$/m,
    // True plain-text ">" quoted line (Gmail text/plain parts)
    /^[ \t]*>.*$/m,
  ];

  let cut = text.length;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

export function isHumanUnsubscribeRequest(bodyLower: string): boolean {
  // Short-body standalone keyword: if the entire message (trimmed)
  // is essentially just "unsubscribe" (with optional punctuation),
  // it's unambiguously a human opt-out.
  const trimmed = bodyLower.replace(/[^a-z\s]/g, "").trim();
  if (/^unsubscribe$/.test(trimmed)) return true;

  // Phrase-level patterns
  return (
    /\bunsubscribe\b/.test(bodyLower) ||
    /\bstop\s+(sending|emailing)\b/.test(bodyLower) ||
    /\bremove\s+me\b/.test(bodyLower) ||
    /\bopt\s*out\b/.test(bodyLower) ||
    /\btake\s+me\s+off\b/.test(bodyLower) ||
    /\bno\s+more\s+emails?\b/.test(bodyLower) ||
    /\bplease\s+(don['']t|do\s+not|stop)\s+(email|contact|reach|send)\b/.test(bodyLower) ||
    /\bstop\s+contacting\b/.test(bodyLower) ||
    /\bdon['']t\s+(email|contact|send)\b/.test(bodyLower)
  );
}
