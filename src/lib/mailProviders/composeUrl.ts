// ============================================================
// composeUrl — provider-agnostic mailto-style deep links
//
// Builds compose URLs for Gmail and Outlook web clients with
// per-account host detection for personal vs. work Outlook.
// ============================================================

const PERSONAL_OUTLOOK_DOMAINS = new Set([
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "passport.com",
  "outlook.fr",
  "outlook.de",
  "hotmail.fr",
  "hotmail.co.uk",
  "live.fr",
]);

export function isPersonalOutlookDomain(email?: string | null): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return PERSONAL_OUTLOOK_DOMAINS.has(domain);
}

export function buildGmailComposeUrl(
  to: string,
  subject: string,
  body: string,
  fromEmail?: string,
): string {
  const params = new URLSearchParams();
  params.set("to", to);
  params.set("su", subject);
  params.set("body", body);

  if (fromEmail) {
    params.set("authuser", fromEmail);
    const encodedEmail = encodeURIComponent(fromEmail);
    return `https://mail.google.com/mail/u/${encodedEmail}/?view=cm&fs=1&${params.toString()}`;
  }

  return `https://mail.google.com/mail/?view=cm&fs=1&${params.toString()}`;
}

export function buildOutlookComposeUrl(
  to: string,
  subject: string,
  body: string,
  fromEmail?: string | null,
): string {
  const params = new URLSearchParams();
  params.set("to", to);
  params.set("subject", subject);
  params.set("body", body);

  if (isPersonalOutlookDomain(fromEmail)) {
    // Personal OWA (outlook.com / hotmail.com / live.com).
    params.set("path", "/mail/action/compose");
    return `https://outlook.live.com/owa/?${params.toString()}`;
  }

  // Work / school (Microsoft 365), including custom domains.
  return `https://outlook.office.com/mail/deeplink/compose?${params.toString()}`;
}
