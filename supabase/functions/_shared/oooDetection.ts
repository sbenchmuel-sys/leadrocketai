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

// ── Defer / "reconnect later" detection ──
// These are NOT auto-replies. They are human emails saying "let's talk later".

const DEFER_PATTERNS = [
  // Explicit reconnect requests
  /(?:reconnect|reach out|follow[- ]?up|circle back|touch base|get (?:back )?in touch|be in touch|connect again|revisit|re-?engage|pick (?:this )?up)\s+(?:after|in|around|post|following|next)\s+(.{3,40})/i,
  // "Let's speak/talk in..."
  /(?:let'?s|we (?:can|should|could)|happy to|would (?:like|love) to)\s+(?:speak|talk|chat|discuss|reconnect|revisit|resume|meet)\s+(?:again\s+)?(?:after|in|around|post|next)\s+(.{3,40})/i,
  // "defer to next..."
  /(?:defer(?:red)?|postpone[d]?|push(?:ed)?|move[d]?|delay(?:ed)?|shelve[d]?|table[d]?)\s+(?:to|until|for|till)\s+(.{3,40})/i,
  // "after March / after Q2 / next financial year"
  /(?:we'?(?:d|ll)|I'?(?:d|ll)|let'?s)\s+(?:like to|love to|plan to|want to)?\s*(?:reconnect|revisit|resume|pick (?:this )?up|follow[- ]?up|get back|circle back)\s+(.{3,40})/i,
  // "budget next year / next FY / next quarter"
  /(?:budget|funding|resources?|bandwidth)\s+(?:(?:is |are )?(?:not |un)?available|allocated|approved)\s+(?:in|for|after|next|until)\s+(.{3,40})/i,
];

const QUARTER_MAP: Record<string, number> = { q1: 0, q2: 3, q3: 6, q4: 9 };

export interface DeferResult {
  isDefer: boolean;
  reconnectDate: Date | null;
  rawMatch: string | null;
  reason: string | null;
}

/**
 * Detect "reconnect later" / "defer" signals in human inbound emails.
 * Returns a parsed reconnect date when possible.
 */
export function detectDeferSignal(bodyText: string, emailDate: Date): DeferResult {
  for (const pattern of DEFER_PATTERNS) {
    const match = pattern.exec(bodyText);
    if (match && match[1]) {
      const rawMatch = match[1].trim().replace(/[.,;:!]+$/, "");
      const reconnectDate = parseDeferDate(rawMatch, emailDate);
      // Build a human-readable reason from surrounding context
      const sentenceStart = Math.max(0, (match.index ?? 0) - 60);
      const sentenceEnd = Math.min(bodyText.length, (match.index ?? 0) + match[0].length + 60);
      const reason = bodyText.slice(sentenceStart, sentenceEnd).replace(/\s+/g, " ").trim();
      return { isDefer: true, reconnectDate, rawMatch, reason };
    }
  }
  return { isDefer: false, reconnectDate: null, rawMatch: null, reason: null };
}

/**
 * Parse a defer date from extracted text like "March 2026", "Q2", "next quarter",
 * "the next financial year", "April", etc.
 */
export function parseDeferDate(text: string, emailDate: Date): Date | null {
  const lower = text.toLowerCase().trim();
  const emailYear = emailDate.getFullYear();
  const emailMonth = emailDate.getMonth();

  // Try "after March 2026" / "March 2026" / "March"
  const monthYearRegex = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s*(\d{4})?\b/i;
  const monthMatch = monthYearRegex.exec(lower);
  if (monthMatch) {
    const month = MONTHS[monthMatch[1].toLowerCase()];
    if (month !== undefined) {
      let year = monthMatch[2] ? parseInt(monthMatch[2]) : emailYear;
      // If month is in the past for this year, assume next year
      if (!monthMatch[2] && month <= emailMonth) year++;
      // "after March" → start of April (month + 1)
      const targetMonth = lower.includes("after") ? month + 1 : month;
      const d = new Date(year, targetMonth, 1);
      d.setHours(9, 30, 0, 0);
      return d;
    }
  }

  // Quarter: "Q2", "Q2 2026", "next quarter"
  const quarterRegex = /\b(q[1-4])\s*(\d{4})?\b/i;
  const qMatch = quarterRegex.exec(lower);
  if (qMatch) {
    const qMonth = QUARTER_MAP[qMatch[1].toLowerCase()];
    let year = qMatch[2] ? parseInt(qMatch[2]) : emailYear;
    if (!qMatch[2] && qMonth <= emailMonth) year++;
    const d = new Date(year, qMonth, 1);
    d.setHours(9, 30, 0, 0);
    return d;
  }

  if (/next\s+quarter/i.test(lower)) {
    const nextQ = Math.ceil((emailMonth + 1) / 3) * 3;
    const year = nextQ >= 12 ? emailYear + 1 : emailYear;
    const d = new Date(year, nextQ % 12, 1);
    d.setHours(9, 30, 0, 0);
    return d;
  }

  // "next year" / "next financial year" / "next FY"
  if (/next\s+(?:financial\s+)?(?:year|fy)/i.test(lower)) {
    // Financial year typically starts April; calendar year starts Jan
    const isFY = /financial|fy/i.test(lower);
    const d = isFY ? new Date(emailYear + 1, 3, 1) : new Date(emailYear + 1, 0, 1);
    d.setHours(9, 30, 0, 0);
    return d;
  }

  // "X months" / "a few weeks" / "a couple of months"
  const relativeRegex = /(\d+|a few|a couple(?: of)?|several)\s+(week|month|day)s?/i;
  const relMatch = relativeRegex.exec(lower);
  if (relMatch) {
    let amount = parseInt(relMatch[1]);
    if (isNaN(amount)) {
      if (/a few|several/i.test(relMatch[1])) amount = 3;
      else if (/a couple/i.test(relMatch[1])) amount = 2;
      else amount = 1;
    }
    const unit = relMatch[2].toLowerCase();
    const d = new Date(emailDate);
    if (unit === "day") d.setDate(d.getDate() + amount);
    else if (unit === "week") d.setDate(d.getDate() + amount * 7);
    else if (unit === "month") d.setMonth(d.getMonth() + amount);
    d.setHours(9, 30, 0, 0);
    return d;
  }

  // Fall back to the generic parseReturnDate from the OOO module
  return parseReturnDate(text);
}
