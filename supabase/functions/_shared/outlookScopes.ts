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
