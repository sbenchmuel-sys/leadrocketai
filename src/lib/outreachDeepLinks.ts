// ============================================================================
// Deep-link builders for manual Outreach touches (Unit C, PR 3)
//
// Manual touches go out through the rep's OWN phone + apps, not DrivePilot's
// pipeline. These build the OS deep-links that open the dialer / texting app /
// WhatsApp pre-filled. Plain sales language only on screen — no "deep-link" or
// "intent" jargon (those words stay in code).
// ============================================================================

/** Keep a leading + and digits only (E.164-ish), strip everything else. */
function cleanPhone(raw: string): string {
  const trimmed = (raw || "").trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  return plus + trimmed.replace(/[^\d]/g, "");
}

/** tel: link — opens the dialer. */
export function telLink(phone: string): string {
  return `tel:${cleanPhone(phone)}`;
}

/** sms: link with the message pre-filled, so the texting app opens ready to send. */
export function smsLink(phone: string, message: string): string {
  const body = encodeURIComponent(message || "");
  // `?body=` is the most broadly-supported form across iOS and Android.
  return `sms:${cleanPhone(phone)}?body=${body}`;
}

/**
 * wa.me link with the chat pre-filled. wa.me works on browser, desktop, and
 * Android/iOS (it hands off to the installed app). The intent:// form is only
 * needed inside a native Android webview, which this web app isn't.
 */
export function whatsappLink(number: string, message: string): string {
  const digits = cleanPhone(number).replace(/^\+/, ""); // wa.me wants no leading +
  const text = encodeURIComponent(message || "");
  return `https://wa.me/${digits}?text=${text}`;
}

/**
 * LinkedIn can't pre-fill a message via a link, so the flow is: copy the prepared
 * message to the clipboard reliably + silently, then open the profile so the rep
 * pastes and sends. Returns true if the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
