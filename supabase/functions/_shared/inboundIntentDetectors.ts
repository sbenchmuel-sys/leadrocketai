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
// commitments". The same holds for any auto-reply or calendar accept
// whose body carries a live commercial question ("Accepted: Demo — and
// can you send pricing?"): a deterministic verdict there would hide the
// card and bury a real question, so those fall through too. And
// `unsubscribe` is only emitted when the caller supplies headers, since
// the helper's contract puts the List-Unsubscribe guard on the caller.
//
// Purity: no Deno.*, no createClient, no import.meta.env — this module
// is imported from Deno edge functions AND from vitest via the
// `@shared/*` alias (see src/test/sharedPurity.test.ts).
// ============================================================

import { isOutOfOfficeReply, type OOOResult } from "./oooDetection.ts";
import {
  detectMeetingConfirmation,
  detectSubstantiveQuestionInAccept,
  type MeetingConfirmationResult,
} from "./meetingConfirmation.ts";
import { isHumanUnsubscribeRequest, stripQuotedReply } from "./unsubscribeDetection.ts";
import { detectBounce } from "./bounceDetection.ts";
import { detectZoomRecap } from "./zoomRecapDetection.ts";
import { emailDomain, normalizeEmail } from "./leadCandidateDetection.ts";

/**
 * The intents this chain can emit. MUST stay a superset of the Queue's
 * hide set (`QUEUE_INTENT_HIDE_SET` in src/lib/queueQueries.ts) —
 * that invariant is pinned by src/test/queueInboundClassification.test.ts
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
  /**
   * The body to scan. In the live sync paths this is the FULL body; in
   * `classify-inbound` it is `snippet_text`, which `timelineProjector`
   * truncates to 500 characters — hence `substantiveQuestion` below.
   * May be "" once the 72h purge has run.
   */
  body: string;
  /** RFC headers when the caller has them (live sync). Empty is fine. */
  headers?: Array<{ name: string; value: string }>;
  /**
   * Authoritative "the sender asked a live commercial question" verdict,
   * decided against the FULL body by the sync path and persisted on the
   * timeline row (see SUBSTANTIVE_QUESTION_FLAG).
   *
   * WHY: `body` here is a 500-char snippet. A question sitting past that
   * cut is invisible to us, so re-deriving the verdict would return
   * `ooo_reply` / `calendar_accept`, the Queue would hide the card, and
   * the live-sync override that deliberately kept the lead actionable
   * would be silently defeated. (Codex P1 on PR #143.)
   *
   * `true`      → force the OOO / meeting branches to fall through to the AI.
   * `false`     → trust it: the full body had no question. Do not re-derive.
   * `undefined` → no verdict was persisted; derive from `body` as before.
   */
  substantiveQuestion?: boolean;
}

/**
 * `metadata_json` key holding the full-body substantive-question verdict.
 * Written by the sync paths at insert time, read by `classify-inbound`.
 */
export const SUBSTANTIVE_QUESTION_FLAG = "has_substantive_question";

/**
 * The verdict the sync paths persist. One helper so the four insert sites
 * and the classifier cannot drift; `detectSubstantiveQuestionInAccept`
 * strips quoted history internally, so our own quoted pitch cannot
 * trigger it.
 */
export function hasSubstantiveQuestion(bodyText: string | null | undefined): boolean {
  return detectSubstantiveQuestionInAccept(bodyText ?? "").length > 0;
}

/** Read the persisted verdict back off a timeline row's metadata_json. */
export function readSubstantiveQuestionFlag(
  metadata: Record<string, unknown> | null | undefined,
): boolean | undefined {
  const v = (metadata ?? {})[SUBSTANTIVE_QUESTION_FLAG];
  return typeof v === "boolean" ? v : undefined;
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
 * The persisted full-body verdict wins over anything we can derive from a
 * possibly-truncated `body`. Only falls back to the derived value when no
 * verdict was persisted (`undefined`).
 */
function questionOverride(input: InboundDetectorInput, derived: boolean): boolean {
  return input.substantiveQuestion ?? derived;
}

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
  //
  // EXCEPT when the auto-reply body also carries a live commercial
  // question ("I'm out until Monday — can you send the updated pricing
  // before then?"). Labelling that `ooo_reply` would hide it from the
  // Queue (ooo_reply is in QUEUE_INTENT_HIDE_SET) and so cancel out the
  // `needs_action` that applyOOOPause deliberately keeps — the rep would
  // lose the question inside one classification cycle. Same treatment as
  // `defer_request` above: emit NO deterministic match so the row flows
  // to the AI, gets a substantive intent, and gets its durable
  // `ai_summary`. The send-side pause is unaffected — that is
  // applyOOOPause's job and it runs on the sync path, not here.
  const ooo = isOutOfOfficeReply(input.headers ?? [], subject, body);
  if (ooo.isOOO) {
    if (questionOverride(input, ooo.hasSubstantiveQuestion)) {
      return { intent: null, ooo, meeting: null };
    }
    return { intent: "ooo_reply", ooo, meeting: null };
  }

  // 3. unsubscribe — explicit human opt-out phrases only, and ONLY when
  // we have the two things the helper's contract requires:
  //
  //   (a) the sender's own prose, quoted history removed. The keyword
  //       regexes run over the whole body, so a normal reply whose quoted
  //       thread (or a newsletter footer below it) contains "unsubscribe"
  //       would be classified `unsubscribe` and hidden. The live Gmail and
  //       Outlook handlers already call stripQuotedReply first; this chain
  //       did not. stripQuotedReply is idempotent, so callers that already
  //       stripped lose nothing.
  //
  //   (b) the List-Unsubscribe header check the helper's own docblock
  //       makes the CALLER responsible for ("newsletters should be
  //       excluded before calling this function"). Timeline rows do not
  //       persist headers, so `classify-inbound` cannot supply it — and
  //       without it we must NOT emit a terminal, hide-the-card verdict.
  //       No headers → fall through to the AI. Marking a live lead
  //       unsubscribed on a footer match is the expensive mistake here;
  //       an extra AI call is the cheap one.
  //
  // Both directions of this are pinned by the `unsubscribeNeedsContext`
  // tests. Callers that DO have headers (the sync paths) still get the
  // deterministic verdict.
  const headers = input.headers;
  if (headers && body) {
    const hasListUnsubscribe = headers.some(
      (h) => h.name.toLowerCase() === "list-unsubscribe" && !!h.value,
    );
    const senderProse = stripQuotedReply(body);
    if (!hasListUnsubscribe && senderProse && isHumanUnsubscribeRequest(senderProse.toLowerCase())) {
      return { intent: "unsubscribe", ooo: null, meeting: null };
    }
  }

  // 4 + 5. meeting confirmation / calendar accept.
  //
  // Same exception as the OOO branch above, for the same reason:
  // "Accepted: Demo — and can you send pricing?" sets
  // hasSubstantiveQuestion, and the sync handlers deliberately KEEP the
  // lead actionable for it. Returning `calendar_accept` here would hide
  // the card anyway (shouldHideFromQueue checks the intent set first),
  // cancelling that out — the exact failure mode we already fixed once
  // for OOO. Fall through to the AI so it gets a substantive intent, a
  // durable ai_summary, and stays on the rep's board.
  const meeting = detectMeetingConfirmation(subject, body);
  if (meeting.isConfirmed) {
    if (questionOverride(input, meeting.hasSubstantiveQuestion)) {
      return { intent: null, ooo: null, meeting };
    }
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

// ── Sender identity ────────────────────────────────────────────────

/**
 * Strip an RFC-2822 display-name wrapper, then apply the project's
 * standard address normalization (lowercase + drop `+tag` aliasing).
 *
 *   `"Dana Ruiz" <Dana+dp@Acme.com>` → `dana@acme.com`
 *
 * Reuses `normalizeEmail` from leadCandidateDetection.ts rather than
 * adding a third normalizer; that one already handles plus-aliasing,
 * which matters here (dana+drivepilot@ is still Dana).
 */
export function bareEmail(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const angle = s.match(/<([^>]+)>/);
  return normalizeEmail(angle ? angle[1] : s);
}

/**
 * Did the person we think we're selling to actually send this, or was it
 * a third party on the thread?
 *
 *   true  — same address (after normalization).
 *   null  — can't tell. INCLUDES the same-domain case; see below.
 *   false — different address AND a different organisation.
 *
 * Only `false` hides a Queue card, so `false` has to be the confident
 * answer rather than the default. Customers legitimately reply from an
 * alias, a shared inbox (procurement@, billing@) or a second address at
 * the same company — all differ from `leads.email` in the local part
 * while staying on the lead's domain. Calling those `false` would hide a
 * genuine reply, the single worst failure this unit could introduce. So
 * a domain match downgrades the verdict to `null` (unknown → visible),
 * and only a wholly different organisation yields `false`.
 *
 * ponytail: compares against `leads.email` only — `contacts` carries no
 * email column in this schema, so "a known contact on that lead" is not
 * checkable from the data the row has. Ceiling: a colleague at the
 * lead's own company reads as `null`, i.e. still shown, which is the
 * conservative direction. Upgrade path: replace the same-domain
 * downgrade with a real membership test once contact identities carry
 * addresses.
 */
export function senderIsLead(
  fromEmail: string | null | undefined,
  leadEmail: string | null | undefined,
): boolean | null {
  const from = bareEmail(fromEmail);
  const lead = bareEmail(leadEmail);
  if (!from || !lead) return null;
  if (from === lead) return true;

  const fromDomain = emailDomain(from);
  const leadDomain = emailDomain(lead);
  // Unparseable on either side, or the same company — not confident
  // enough to hide anything.
  if (!fromDomain || !leadDomain || fromDomain === leadDomain) return null;

  return false;
}
