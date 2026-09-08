// ============================================================
// inboundIntentDetectors — deterministic inbound-intent chain.
//
// Single source of truth for "which of the routine, hide-from-queue
// intents does this inbound email match?". Lifted verbatim from the
// one-shot `classify-timeline-intent-backfill` (its `classify()`,
// ~lines 113–153) so the live `classify-inbound` cron and the backfill
// agree by construction instead of by comment.
//
// WHY THIS EXISTS (the bug it fixes): `classify-inbound` only ever
// asked the AI, and the AI's vocabulary
// (book_meeting | pricing | technical_sdk | security_privacy |
//  legal_procurement | partnership | support | not_sure)
// is DISJOINT from the vocabulary the Queue hides on
// (bounce | ooo_reply | calendar_accept | zoom_recap |
//  meeting_confirmation | unsubscribe).
// So the hide list was unreachable for every message that arrived
// after the one-shot backfill ran, and every bounce / OOO / calendar
// accept rendered as a normal "reply needed" card.
//
// Scope, deliberately: this module emits ONLY the six intents the
// Queue hides on. `defer_request` is intentionally NOT emitted here
// even though the backfill detects it — a defer is a real human email
// that still deserves an `ai_summary` (the 72h purge gate opens on
// `intent IS NOT NULL AND ai_summary IS NOT NULL`), so it must keep
// flowing to the AI path rather than short-circuiting to a
// summary-less terminal intent. See CLAUDE.md → "Public product
// commitments".
//
// Purity: no Deno.*, no createClient, no import.meta.env — this module
// is imported from Deno edge functions AND from vitest via the
// `@shared/*` alias (see src/test/sharedPurity.test.ts).
// ============================================================

import { isOutOfOfficeReply, type OOOResult } from "./oooDetection.ts";
import {
  detectMeetingConfirmation,
  type MeetingConfirmationResult,
} from "./meetingConfirmation.ts";
import { isHumanUnsubscribeRequest } from "./unsubscribeDetection.ts";
import { detectBounce } from "./bounceDetection.ts";
import { detectZoomRecap } from "./zoomRecapDetection.ts";

/**
 * The intents this chain can emit. MUST stay a superset of the Queue's
 * hide set (`QUEUE_INTENT_HIDE_SET` in src/lib/queueQueries.ts) —
 * that invariant is pinned by src/lib/inboundIntentDetectors.test.ts
 * (`hideVocabularyMatches`).
 */
export type DeterministicIntent =
  | "bounce"
  | "ooo_reply"
  | "unsubscribe"
  | "meeting_confirmation"
  | "calendar_accept"
  | "zoom_recap";

export const DETERMINISTIC_INTENTS: readonly DeterministicIntent[] = [
  "bounce",
  "ooo_reply",
  "unsubscribe",
  "meeting_confirmation",
  "calendar_accept",
  "zoom_recap",
];

export interface InboundDetectorInput {
  fromEmail: string;
  subject: string;
  /** Raw body / snippet. May be "" once the 72h purge has run. */
  body: string;
  /** RFC headers when the caller has them (live sync). Empty is fine. */
  headers?: Array<{ name: string; value: string }>;
}

export interface InboundDetectorResult {
  /** `null` when nothing matched — caller falls through to the AI. */
  intent: DeterministicIntent | null;
  /** Populated when `intent === 'ooo_reply'`. */
  ooo: OOOResult | null;
  /** Populated for calendar_accept / meeting_confirmation. */
  meeting: MeetingConfirmationResult | null;
}

const NO_MATCH: InboundDetectorResult = { intent: null, ooo: null, meeting: null };

/**
 * Run the documented precedence chain (EDGE_CASES.md #1), first match wins:
 *   bounce > ooo_reply > unsubscribe > meeting_confirmation / calendar_accept > zoom_recap
 *
 * `detectMeetingConfirmation` produces two of those intents from one call:
 *   confidence === "subject" → calendar_accept       ("Accepted: Intro call")
 *   confidence === "body"    → meeting_confirmation  ("see you Tuesday")
 */
export function detectInboundIntent(
  input: InboundDetectorInput,
): InboundDetectorResult {
  const fromEmail = input.fromEmail ?? "";
  const subject = input.subject ?? "";
  const body = input.body ?? "";

  // 1. bounce — sender or subject anchors, no body needed.
  if (detectBounce(fromEmail, subject).isBounce) {
    return { intent: "bounce", ooo: null, meeting: null };
  }

  // 2. ooo_reply — headers are the strongest signal when the caller has
  // them; subject + body patterns still run when it doesn't.
  const ooo = isOutOfOfficeReply(input.headers ?? [], subject, body);
  if (ooo.isOOO) return { intent: "ooo_reply", ooo, meeting: null };

  // 3. unsubscribe — explicit human opt-out phrases only.
  if (body && isHumanUnsubscribeRequest(body.toLowerCase())) {
    return { intent: "unsubscribe", ooo: null, meeting: null };
  }

  // 4 + 5. meeting confirmation / calendar accept.
  const meeting = detectMeetingConfirmation(subject, body);
  if (meeting.isConfirmed) {
    return {
      intent: meeting.confidence === "subject"
        ? "calendar_accept"
        : "meeting_confirmation",
      ooo: null,
      meeting,
    };
  }

  // 6. zoom_recap — last in precedence.
  if (detectZoomRecap(fromEmail, subject, body).isZoomRecap) {
    return { intent: "zoom_recap", ooo: null, meeting: null };
  }

  return NO_MATCH;
}
