// Shared knobs for the meeting pipeline (calendar-sync → transcript-poller
// → *-transcript-fetch). Pure: imported from Deno and from src/ via @shared.

// How far back calendar-sync looks, and how long after a meeting ends the
// transcript poller keeps trying. They must match: an event backfilled by
// calendar-sync after an outage is only useful if the poller still accepts
// it. 3 days covers a weekend outage; Teams/Meet transcripts are still
// downloadable at that age.
export const MEETING_LOOKBACK_DAYS = 3;
export const MEETING_LOOKBACK_MS = MEETING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

// Outlook accounts the meeting pipeline still uses. 'error' is set by
// outlook-subscription-check when the live-update webhook can't be created —
// the OAuth token usually still works, so calendar + transcript polling keep
// going (a dead token fails at refresh and sets needs_reconnect instead).
// 'expired' means the token is gone; skip it.
export const OUTLOOK_MEETING_SYNC_STATUSES = ["connected", "error"];
