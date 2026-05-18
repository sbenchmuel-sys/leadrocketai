// Outlook OAuth scope sets. Each callsite should use the smallest subset
// that covers its needs — Microsoft rejects refresh_token requests whose
// `scope` includes anything outside the user's original grant.
//
// Frontend mirror at src/hooks/useNeedsCalendarReconsent.ts — update both
// together when adding scopes.

// Individual scope identifiers — exported separately because they're
// also used for presence checks against the stored granted_scopes array
// (calendar-sync gates calendar work on this, future transcript fetchers
// will gate on the transcript scope similarly).
export const OUTLOOK_CALENDAR_SCOPE = "Calendars.Read";
export const OUTLOOK_TRANSCRIPT_SCOPE = "OnlineMeetingTranscript.Read.All";

// Mail-only operations (send, reply, mail sync).
// Safe for every pilot (Phase 1 grant included all of these).
export const OUTLOOK_MAIL_SCOPES = [
  "Mail.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "offline_access",
  "User.Read",
];

// Calendar operations.
// Safe for every Phase 1 + Phase 2 pilot.
export const OUTLOOK_CALENDAR_SCOPES = [
  ...OUTLOOK_MAIL_SCOPES,
  OUTLOOK_CALENDAR_SCOPE,
];

// Full bundle requested at consent time. Used by outlook-auth and
// outlook-callback only. Phase 1 pilots will not have these scopes
// granted until they reconsent — DO NOT use this constant in any
// refresh-token path.
export const OUTLOOK_FULL_OAUTH_SCOPES = [
  ...OUTLOOK_CALENDAR_SCOPES,
  "OnlineMeetings.Read",
  OUTLOOK_TRANSCRIPT_SCOPE,
];

export const OUTLOOK_MAIL_SCOPES_STRING = OUTLOOK_MAIL_SCOPES.join(" ");
export const OUTLOOK_CALENDAR_SCOPES_STRING = OUTLOOK_CALENDAR_SCOPES.join(" ");
export const OUTLOOK_FULL_OAUTH_SCOPES_STRING = OUTLOOK_FULL_OAUTH_SCOPES.join(" ");

// Microsoft's consumer (personal-account) tenant. Tokens issued for
// outlook.com / hotmail.com / live.com sign-ins always carry this as
// their `tid` claim. `OnlineMeetingTranscript.Read.All` is a work/school
// delegated-only permission, so personal-tenant tokens never carry it
// even when the user successfully consents to the broader bundle —
// the reconsent hook MUST skip the transcript-scope check for these
// accounts or they get nudged to reconnect on every page load.
export const OUTLOOK_PERSONAL_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

// Decode the `tid` claim from a Microsoft access token (a JWT). Returns
// null if the token is malformed or the claim is missing — callers should
// treat null as "tenant unknown" rather than "definitely work/school".
export function extractTenantIdFromAccessToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (payload.length % 4)) % 4;
    const json = JSON.parse(atob(payload + "=".repeat(padding)));
    return typeof json.tid === "string" ? json.tid : null;
  } catch {
    return null;
  }
}
