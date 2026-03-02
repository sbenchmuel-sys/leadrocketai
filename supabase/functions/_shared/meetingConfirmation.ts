/**
 * Shared meeting confirmation detection helpers.
 * Detects "see you on Wednesday", calendar acceptances, etc.
 * Used by gmail-sync, gmail-bulk-sync, outlook-sync, outlook-webhook.
 */

const MEETING_BODY_PATTERNS = [
  // "see you on Wednesday / Thursday / March 5"
  /\bsee you (?:on |this |next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|\d{1,2}[\/-]\d{1,2})/i,
  // "see you then"
  /\bsee you then\b/i,
  // "looking forward to our meeting/call"
  /\blooking forward to (?:our |the )?(?:meeting|call|chat|discussion|session|demo|presentation|sync|catch[- ]?up)/i,
  // "confirmed for Wednesday"
  /\bconfirmed? (?:for |on )/i,
  // "meeting is confirmed"
  /\bmeeting (?:is |has been )?confirmed\b/i,
  // "calendar invite sent/accepted"
  /\bcalendar (?:invite|invitation) (?:sent|accepted)\b/i,
  // "I've accepted the invite"
  /\b(?:i'?ve |i have )?accepted (?:the |your )?(?:invite|invitation|meeting)\b/i,
];

const CALENDAR_SUBJECT_PATTERNS = [
  // Calendar acceptance: "Accepted: Intro call with..."
  /^Accepted:/i,
  // Tentative acceptance
  /^Tentatively [Aa]ccepted:/i,
  // Google Calendar: "Invitation: Meeting @ date"
  /^Invitation:/i,
];

export interface MeetingConfirmationResult {
  isConfirmed: boolean;
  confidence: "subject" | "body" | null;
  matchedText: string | null;
}

/**
 * Detect if an email is a meeting confirmation based on subject and body.
 * Calendar acceptance subjects are the strongest signal.
 * Body patterns like "see you on Wednesday" are secondary.
 */
export function detectMeetingConfirmation(
  subject: string,
  bodyText: string
): MeetingConfirmationResult {
  // 1. Calendar acceptance subjects (strongest signal)
  for (const pattern of CALENDAR_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) {
      return {
        isConfirmed: true,
        confidence: "subject",
        matchedText: subject.slice(0, 80),
      };
    }
  }

  // 2. Body patterns (secondary signal)
  for (const pattern of MEETING_BODY_PATTERNS) {
    const match = pattern.exec(bodyText);
    if (match) {
      return {
        isConfirmed: true,
        confidence: "body",
        matchedText: match[0],
      };
    }
  }

  return { isConfirmed: false, confidence: null, matchedText: null };
}
