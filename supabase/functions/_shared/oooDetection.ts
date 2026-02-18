/**
 * Shared OOO (Out-of-Office) auto-reply detection helpers.
 * Used by gmail-sync, gmail-bulk-sync, and future outlook-sync.
 */

const OOO_SUBJECT_PATTERNS = [
  /out of office/i,
  /\bOOO\b/,
  /auto.?reply/i,
  /automatic reply/i,
  /on vacation/i,
  /away from (the )?office/i,
  /out of the office/i,
  /on leave/i,
  /i('m| am) out/i,
  /autoreply/i,
  /currently away/i,
  /currently unavailable/i,
  /annual leave/i,
  /holiday notification/i,
];

const OOO_HEADER_INDICATORS = [
  // Standard RFC headers
  { header: "auto-submitted", value: /auto-replied|auto-generated/i },
  { header: "x-autoreply", value: /yes/i },
  { header: "x-auto-response-suppress", value: /.+/ }, // any value means suppress
  { header: "precedence", value: /auto-reply|junk|bulk/i },
];

const OOO_BODY_PATTERNS = [
  /i('m| will be| am) (currently )?(out of|away from|on leave|on vacation)/i,
  /currently out of the office/i,
  /out of office until/i,
  /returning (on|around)/i,
  /back (in the office |on |around )/i,
  /i'll be back/i,
  /will return (on|around)/i,
  /available (from|on|after)/i,
  /away until/i,
  /on (annual )?leave until/i,
];

export interface OOOResult {
  isOOO: boolean;
  returnDate: Date | null;
  confidence: "header" | "subject" | "body" | null;
}

/**
 * Detect if an email is an OOO auto-reply based on headers, subject, and body.
 * Headers are the most reliable signal; subject is very reliable; body is secondary.
 */
export function isOutOfOfficeReply(
  headers: Array<{ name: string; value: string }>,
  subject: string,
  bodyText: string
): OOOResult {
  // 1. Check headers (most reliable)
  for (const indicator of OOO_HEADER_INDICATORS) {
    const headerValue = headers.find(
      (h) => h.name.toLowerCase() === indicator.header.toLowerCase()
    )?.value;
    if (headerValue && indicator.value.test(headerValue)) {
      const returnDate = parseReturnDate(bodyText);
      return { isOOO: true, returnDate, confidence: "header" };
    }
  }

  // 2. Check subject line (very reliable)
  for (const pattern of OOO_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) {
      const returnDate = parseReturnDate(bodyText);
      return { isOOO: true, returnDate, confidence: "subject" };
    }
  }

  // 3. Check body (secondary signal — only if multiple OOO body patterns match)
  let bodyMatchCount = 0;
  for (const pattern of OOO_BODY_PATTERNS) {
    if (pattern.test(bodyText)) {
      bodyMatchCount++;
      if (bodyMatchCount >= 2) {
        const returnDate = parseReturnDate(bodyText);
        return { isOOO: true, returnDate, confidence: "body" };
      }
    }
  }

  return { isOOO: false, returnDate: null, confidence: null };
}

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

/**
 * Parse a return date from OOO email body text.
 * Returns a Date object if found, or null if not found.
 * Only returns dates that are in the future.
 */
export function parseReturnDate(bodyText: string): Date | null {
  const now = new Date();
  const currentYear = now.getFullYear();
  const candidates: Date[] = [];

  // 1. ISO format: YYYY-MM-DD
  const isoRegex = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = isoRegex.exec(bodyText)) !== null) {
    const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    if (!isNaN(d.getTime())) candidates.push(d);
  }

  // 2. US format: MM/DD/YYYY or MM/DD
  const usRegex = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g;
  while ((m = usRegex.exec(bodyText)) !== null) {
    const month = parseInt(m[1]) - 1;
    const day = parseInt(m[2]);
    const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : currentYear;
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime()) && month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      candidates.push(d);
    }
  }

  // 3. Natural language: "March 5", "5th March", "March 5, 2025", "5 March 2025"
  const monthNames = Object.keys(MONTHS).filter((k) => k.length > 3).join("|");
  const monthAbbrs = Object.keys(MONTHS).filter((k) => k.length <= 3 || k === "may").join("|");
  const allMonths = `${monthNames}|${monthAbbrs}`;

  // Month Day(st/nd/rd/th) (Year)?
  const nlRegex1 = new RegExp(
    `\\b(${allMonths})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
    "gi"
  );
  while ((m = nlRegex1.exec(bodyText)) !== null) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = parseInt(m[2]);
    const year = m[3] ? parseInt(m[3]) : currentYear;
    if (month !== undefined) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) candidates.push(d);
    }
  }

  // Day(st/nd/rd/th) Month (Year)?
  const nlRegex2 = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${allMonths})(?:,?\\s+(\\d{4}))?\\b`,
    "gi"
  );
  while ((m = nlRegex2.exec(bodyText)) !== null) {
    const day = parseInt(m[1]);
    const month = MONTHS[m[2].toLowerCase()];
    const year = m[3] ? parseInt(m[3]) : currentYear;
    if (month !== undefined) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) candidates.push(d);
    }
  }

  // Filter to future dates and pick the earliest one
  const futureDates = candidates.filter((d) => d > now);
  if (futureDates.length === 0) return null;

  futureDates.sort((a, b) => a.getTime() - b.getTime());
  return futureDates[0];
}

/**
 * Calculate the eligible_at timestamp for after OOO.
 * Uses parsed return date at 9:30 AM, or falls back to now + 7 days.
 */
export function getOOOEligibleAt(returnDate: Date | null): string {
  const target = returnDate ? new Date(returnDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  target.setHours(9, 30, 0, 0);
  // If the return date (after setting 9:30) is still in the past, add 7 days
  if (target.getTime() <= Date.now()) {
    target.setDate(target.getDate() + 7);
  }
  return target.toISOString();
}
