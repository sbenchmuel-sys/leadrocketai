/**
 * Shared bounce / NDR (non-delivery report) detection.
 *
 * Extracted from the inline copies in:
 *   - supabase/functions/gmail-sync/index.ts   (~lines 387–397)
 *   - supabase/functions/outlook-sync/index.ts (~lines 277–287)
 *
 * Logic is identical to both inline copies. Phase 2a will migrate
 * those callers to import from this module so there is a single
 * source of truth; until then the inline copies remain authoritative
 * for the live sync path and this module is consumed by the
 * `classify-timeline-intent-backfill` edge function only.
 *
 * Detects system-generated bounce messages from postmaster /
 * mailer-daemon / mail-delivery senders or by NDR subject lines.
 */

const BOUNCE_FROM_KEYWORDS = [
  "postmaster",
  "mailer-daemon",
  "mail delivery",
];

const BOUNCE_SUBJECT_KEYWORDS = [
  "delivery status notification",
  "undeliverable",
  "mail delivery failed",
  "returned mail",
  "failure notice",
  "delivery failure",
];

export interface BounceResult {
  isBounce: boolean;
  /** Which signal tripped: "from" (postmaster-style sender) or "subject". */
  reason: "from" | "subject" | null;
}

/**
 * Detect whether an email is a delivery-failure / bounce notification.
 * Pass the raw `From:` header value and the raw subject line.
 */
export function detectBounce(fromEmail: string, subject: string): BounceResult {
  const fromLower = (fromEmail || "").toLowerCase();
  const subjectLower = (subject || "").toLowerCase();

  if (BOUNCE_FROM_KEYWORDS.some((kw) => fromLower.includes(kw))) {
    return { isBounce: true, reason: "from" };
  }
  if (BOUNCE_SUBJECT_KEYWORDS.some((kw) => subjectLower.includes(kw))) {
    return { isBounce: true, reason: "subject" };
  }
  return { isBounce: false, reason: null };
}

// ───────────────────────────────────────────────────────────────────────────
// Soft vs hard bounce classification (RFC 3463)
//
// `detectBounce` above only answers "is this a DSN?". Once we know a message is
// a bounce we must still decide whether it is PERMANENT (a bad address — suppress
// the lead, end the cadence, count toward the bounce circuit breaker) or
// TRANSIENT (mailbox full, greylisting, a temporary defer — leave the lead alone
// and let the cadence retry on its normal schedule).
//
// The old behaviour treated EVERY keyword match as permanent, so a soft/transient
// bounce wrongly set leads.unsubscribed = true and killed the cadence forever —
// burning a perfectly good lead. This classifier fixes that.
//
// FAIL-SAFE DIRECTION (deliberate — the OPPOSITE of the reply-stop guardrail):
// here the expensive, irreversible mistake is destroying a good lead, so when a
// bounce is unclassifiable we treat it as TRANSIENT. We only suppress when the
// signal CLEARLY says permanent: a 5.x.x enhanced status code, or an unmistakable
// permanent-failure phrase. "When in doubt, don't suppress."
// ───────────────────────────────────────────────────────────────────────────

export type BounceSeverity = "hard" | "soft";

export interface BounceClassification {
  /** "hard" = permanent failure (suppress); "soft" = transient (keep retrying). */
  severity: BounceSeverity;
  /** The RFC 3463 enhanced status code that decided it (e.g. "5.1.1"), if found. */
  statusCode: string | null;
  /**
   * How the decision was reached:
   *  - "code"     a 4.x.x / 5.x.x enhanced status code was found
   *  - "keyword"  no code, but a clear permanent-failure phrase matched
   *  - "fallback" no code and no clear phrase → fail-safe transient
   */
  basis: "code" | "keyword" | "fallback";
}

// Phrases that UNAMBIGUOUSLY mean the address is permanently bad. Used only as a
// fallback when no enhanced status code is present. Deliberately narrow: generic
// DSN wording ("undeliverable", "delivery status notification", "failure notice",
// "returned mail", "delivery failure") is NOT here, because on its own — with no
// status code — it is ambiguous, and the fail-safe direction keeps the lead.
const HARD_PERMANENT_KEYWORDS = [
  "user unknown",
  "no such user",
  "no such recipient",
  "no such address",
  "no such mailbox",
  "user not found",
  "recipient not found",
  "recipient address rejected",
  "address not found",
  "address does not exist",
  "does not exist",
  "account that you tried to reach does not exist",
  "account has been disabled",
  "account is disabled",
  "mailbox not found",
  "mailbox does not exist",
  "unknown recipient",
  "unrouteable address",
  "unroutable address",
  "permanent failure",
  "permanently failed",
];

/**
 * Find the most severe RFC 3463 enhanced status code (class.subject.detail,
 * class ∈ {4,5}) in `text`. 5.x.x (permanent) outranks 4.x.x (transient).
 *
 * Matches the code in the two forms a DSN actually carries it:
 *   1. the canonical per-recipient DSN field at line start: `Status: 5.1.1`
 *      (may be `>`-quoted when the report is forwarded), and
 *   2. inline, immediately after a 3-digit SMTP reply code, which is how the
 *      human-readable part quotes the remote server: `550 5.1.1`, `450-4.2.2`,
 *      `550 #5.1.1`.
 * Anchoring to these two forms avoids matching stray version-like tokens
 * ("v5.1.1", "uptime 4.0.0") that are not delivery codes. We ignore 2.x.x
 * (success) codes entirely.
 */
function findEnhancedStatusClass(text: string): { code: string; cls: 4 | 5 } | null {
  let best: { code: string; cls: 4 | 5 } | null = null;
  const consider = (code: string) => {
    const cls = Number(code[0]);
    if (cls !== 4 && cls !== 5) return;
    if (!best || cls > best.cls) best = { code, cls: cls as 4 | 5 };
  };
  const collect = (re: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) consider(m[1]);
  };

  // Form 1: canonical "Status:" DSN field at line start (may be `>`-quoted).
  collect(/^[ \t>]*Status:[ \t]*([45]\.\d{1,3}\.\d{1,3})\b/gim);
  // Form 2: enhanced code adjacent to a 3-digit SMTP reply code.
  collect(/\b[245]\d{2}[ \t-]+#?([45]\.\d{1,3}\.\d{1,3})\b/g);

  return best;
}

/**
 * Fallback for DSNs that carry only a basic 3-digit SMTP reply code and no
 * enhanced status code, e.g. `Diagnostic-Code: smtp; 550 mailbox unavailable`.
 * SMTP class is decisive: 5yz = permanent (hard), 4yz = transient (soft).
 *
 * Scanned per line and gated by a DSN-specific marker (Diagnostic-Code / smtp /
 * remote-server phrasing) so an ordinary number elsewhere in the report
 * ("reported 550 leads") can't be mistaken for a reply code. Most severe wins.
 */
function findReplyCodeClass(text: string): { code: string; cls: 4 | 5 } | null {
  const marker = /(diagnostic-code|\bsmtp\b|remote server|the response (?:from|was)|server (?:returned|said|responded))/i;
  const codeRe = /(?:^|[^\d.])([45]\d{2})(?:[ \t).;:'"\]-]|$)/;
  let best: { code: string; cls: 4 | 5 } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!marker.test(line)) continue;
    const m = codeRe.exec(line);
    if (!m) continue;
    const cls = Number(m[1][0]) as 4 | 5;
    if (!best || cls > best.cls) best = { code: m[1], cls };
  }
  return best;
}

/**
 * A single DSN (RFC 3464) can report MANY failed recipients, each in its own
 * per-recipient group that starts with a `Final-Recipient:` (or
 * `Original-Recipient:`) line and carries its own `Action:` / `Status:`. If a
 * report lists recipient A as 5.x.x (permanent) and recipient B as 4.x.x
 * (transient), a whole-body "5 outranks 4" scan would mark B hard off A's code
 * — wrongly burning a recoverable lead. Since the callers only check that the
 * lead's address appears SOMEWHERE in the body before attributing, we isolate
 * the block(s) that actually name this recipient and classify only those.
 *
 * Returns the matching block(s) joined, or null when:
 *   - the body has fewer than two recipient groups (single-recipient DSN — the
 *     whole body already is this recipient's, so nothing to scope), or
 *   - no structured group names this recipient (e.g. only the human-readable
 *     preamble mentions them) — caller falls back to whole-body classification.
 */
function scopeToRecipientBlocks(body: string, recipientEmail: string): string | null {
  if (!body || !recipientEmail) return null;

  // Per RFC 3464 a per-recipient group is `[Original-Recipient] Final-Recipient
  // Action Status …`: Original-Recipient (the address the sender used) is
  // OPTIONAL and, when present, comes immediately before Final-Recipient (the
  // address after forwarding/aliasing) IN THE SAME GROUP. So a group begins at:
  //   - any Original-Recipient line, or
  //   - a Final-Recipient line that does NOT directly follow an Original-Recipient
  //     (i.e. a standalone Final-Recipient).
  // Splitting naively on every recipient line would orphan an aliased group's
  // Status onto the Final-Recipient half and lose it for the Original address.
  const re = /^[ \t>]*(Final-Recipient|Original-Recipient):/gim;
  const fields: Array<{ index: number; type: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    fields.push({ index: m.index, type: m[1].toLowerCase() });
  }
  if (fields.length === 0) return null;

  const starts: number[] = [];
  for (let i = 0; i < fields.length; i++) {
    const cur = fields[i];
    if (cur.type === "original-recipient") {
      starts.push(cur.index);
    } else if (!(fields[i - 1] && fields[i - 1].type === "original-recipient")) {
      starts.push(cur.index);
    }
  }
  if (starts.length < 2) return null;

  const target = recipientEmail.toLowerCase();
  const matched: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : body.length;
    const block = body.slice(starts[i], end);
    if (blockNamesRecipient(block, target)) matched.push(block);
  }
  return matched.length > 0 ? matched.join("\n") : null;
}

// Whole-email comparison, NOT substring: a naive `block.includes("ann@x.com")`
// also matches "joann@x.com", so scoping `ann@x.com` could absorb joann's block
// and let his 5.x.x burn ann. Extract full address tokens and compare exactly.
const EMAIL_TOKEN_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
function blockNamesRecipient(block: string, targetLower: string): boolean {
  const emails = block.toLowerCase().match(EMAIL_TOKEN_RE);
  return emails !== null && emails.includes(targetLower);
}

/**
 * Classify a bounce as hard (permanent) or soft (transient).
 *
 * Decision order:
 *   1. An RFC 3463 enhanced status code wins when present: 5.x.x → hard,
 *      4.x.x → soft. (Prefer the code over keywords.)
 *   2. Else a bare 3-digit SMTP reply code in a DSN context: 5yz → hard,
 *      4yz → soft.
 *   3. No code → a clear permanent-failure phrase → hard.
 *   4. Otherwise → soft (fail-safe: don't burn a possibly-good lead).
 *
 * Pass `recipientEmail` (the lead being attributed) so a multi-recipient DSN is
 * classified from THIS recipient's block only — never another recipient's code.
 *
 * Call this ONLY after the message is already known to be a bounce/DSN.
 */
export function classifyBounce(input: {
  fromEmail?: string;
  subject?: string;
  body?: string;
  recipientEmail?: string;
}): BounceClassification {
  const subject = input.subject || "";
  const fullBody = input.body || "";
  const recipient = (input.recipientEmail || "").toLowerCase().trim();
  // Narrow to this recipient's per-recipient block in a multi-recipient report;
  // single-recipient bodies (the common case) are unchanged.
  const body = (recipient && scopeToRecipientBlocks(fullBody, recipient)) || fullBody;
  const haystack = `${subject}\n${body}`;

  // Prefer the enhanced RFC 3463 code; otherwise fall back to a bare 3-digit
  // SMTP reply code (5yz permanent / 4yz transient) found in a DSN context.
  const codeClass = findEnhancedStatusClass(haystack) ?? findReplyCodeClass(haystack);
  if (codeClass) {
    return {
      severity: codeClass.cls === 5 ? "hard" : "soft",
      statusCode: codeClass.code,
      basis: "code",
    };
  }

  const hay = haystack.toLowerCase();
  if (HARD_PERMANENT_KEYWORDS.some((kw) => hay.includes(kw))) {
    return { severity: "hard", statusCode: null, basis: "keyword" };
  }

  return { severity: "soft", statusCode: null, basis: "fallback" };
}
