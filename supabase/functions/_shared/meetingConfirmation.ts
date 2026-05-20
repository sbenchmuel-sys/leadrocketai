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

/**
 * Commercial keywords that, combined with a question mark in the body of a
 * calendar-acceptance email, mean the email is BOTH "I accept the meeting"
 * AND "by the way, I have a substantive question". Exported by name so it
 * can be tuned (in this file) without touching detector or caller logic.
 *
 * Conservative on purpose: every term here must be a single English word
 * that's hard to confuse with a routine acknowledgement. "thanks", "great",
 * "time", "when" are intentionally excluded — they show up in clean accepts
 * ("any questions before then?", "what time works for you?") and would
 * generate noise we'd then have to filter.
 */
export const MEETING_OVERRIDE_KEYWORDS: readonly string[] = [
  "pricing",
  "price",
  "quote",
  "cost",
  "discount",
  "proposal",
  "contract",
  "timeline",
  "deadline",
];

// Word-boundary, case-insensitive matcher built once at module load.
// Matches `\bpricing\b` etc. so "price" matches "the price" but NOT
// "priceless"; "cost" matches "what's the cost" but NOT "costume".
const KEYWORD_REGEX = new RegExp(
  `\\b(?:${MEETING_OVERRIDE_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "gi",
);

export interface MeetingConfirmationResult {
  isConfirmed: boolean;
  confidence: "subject" | "body" | null;
  matchedText: string | null;
  /**
   * True when this is a calendar-accept (confidence === "subject") AND the
   * body contains both a question mark AND at least one commercial keyword
   * from MEETING_OVERRIDE_KEYWORDS. Callers MUST NOT clear `needs_action`
   * when this is true — the meeting was confirmed but the customer still
   * has an open commercial question that needs a reply.
   */
  hasSubstantiveQuestion: boolean;
  /** Commercial keywords that triggered the override. Empty if none. */
  matchedKeywords: string[];
}

/**
 * Scan a calendar-accept body for substantive commercial questions.
 * Returns the set of matched keywords if BOTH a question mark and at
 * least one commercial keyword are present; otherwise `[]`.
 *
 * Exported for unit testing and for callers that want to log the match.
 */
export function detectSubstantiveQuestionInAccept(bodyText: string): string[] {
  if (!bodyText || !bodyText.includes("?")) return [];
  const matches = bodyText.match(KEYWORD_REGEX);
  if (!matches || matches.length === 0) return [];
  // Dedupe + lowercase for stable logging order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const lower = m.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out;
}

/**
 * Detect if an email is a meeting confirmation based on subject and body.
 * Calendar acceptance subjects are the strongest signal.
 * Body patterns like "see you on Wednesday" are secondary.
 *
 * When confidence === "subject", also scan the body for substantive
 * commercial questions (see `MEETING_OVERRIDE_KEYWORDS`). When present,
 * the meeting is still confirmed but `hasSubstantiveQuestion=true` flags
 * to callers that they MUST NOT suppress `needs_action`.
 */
export function detectMeetingConfirmation(
  subject: string,
  bodyText: string,
): MeetingConfirmationResult {
  // 1. Calendar acceptance subjects (strongest signal)
  for (const pattern of CALENDAR_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) {
      const matchedKeywords = detectSubstantiveQuestionInAccept(bodyText);
      return {
        isConfirmed: true,
        confidence: "subject",
        matchedText: subject.slice(0, 80),
        hasSubstantiveQuestion: matchedKeywords.length > 0,
        matchedKeywords,
      };
    }
  }

  // 2. Body patterns (secondary signal)
  // Body-pattern matches are looser by nature ("see you Tuesday") and we
  // already trust the deriveAction REPLY_PENDING branch to keep the lead
  // surfaced if there's a fresh inbound. Don't run the override here.
  for (const pattern of MEETING_BODY_PATTERNS) {
    const match = pattern.exec(bodyText);
    if (match) {
      return {
        isConfirmed: true,
        confidence: "body",
        matchedText: match[0],
        hasSubstantiveQuestion: false,
        matchedKeywords: [],
      };
    }
  }

  return {
    isConfirmed: false,
    confidence: null,
    matchedText: null,
    hasSubstantiveQuestion: false,
    matchedKeywords: [],
  };
}
