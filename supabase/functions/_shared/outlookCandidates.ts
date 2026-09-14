// ============================================================
// outlookCandidates — which Graph messages outlook-sync actually
// imports, and in what order.
//
// WHY THIS IS A MODULE AND NOT A LOOP BODY (Unit G-B P1)
//
// outlook-sync used to take the newest `maxResults` RAW candidates and only
// then apply its skip gates. Graph's candidate set is mostly things the sync
// deliberately drops — drafts, third-party mail, messages already stored,
// messages older than the sync window — so those ineligible messages spent the
// whole budget. A genuine direct reply ranked below the newest 20 raw hits was
// never imported. Not imported LATE: never. The candidate set is stable, so the
// same 20 ineligible messages won the slice on every later sync too, and the
// rep just saw a customer who had not replied.
//
// The fix is "filter first, then count", and the trap in the fix is that the
// thing you count and the thing you later process can disagree. They cannot
// here: the caller loops over exactly what this module returns, and the
// per-message facts it needed to make the decision (`isDirect`, `isFromLead`)
// come back with each message instead of being recomputed.
//
// Pure — no Deno, no client, no I/O — so a vitest spec exercises the real
// selection rather than a re-implementation of it.
// ============================================================

import { isDirectConversation } from "./directConversation.ts";
import { detectBounce } from "./bounceDetection.ts";

/** The subset of a Graph message this module reads. */
export interface OutlookCandidate {
  id: string;
  internetMessageId?: string | null;
  subject?: string | null;
  isDraft?: boolean;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  from?: { emailAddress?: { address?: string | null } | null } | null;
  toRecipients?: Array<{ emailAddress?: { address?: string | null } | null }> | null;
  ccRecipients?: Array<{ emailAddress?: { address?: string | null } | null }> | null;
  bccRecipients?: Array<{ emailAddress?: { address?: string | null } | null }> | null;
}

export interface SelectionContext {
  leadEmail: string;
  repEmail: string;
  /** Messages already stored for this lead, keyed the same way we key them. */
  alreadySyncedIds: ReadonlySet<string>;
  /** messageId -> stored body. An empty body means "re-fetch to restore it". */
  bodyByMessageId: ReadonlyMap<string, string | null | undefined>;
  /** Epoch ms; anything older than this is outside the sync window. */
  syncStartMs: number;
}

export type SkipReason =
  | "already_synced"
  | "draft"
  | "third_party"
  | "too_old"
  | "duplicate_in_batch";

export interface SelectedCandidate<T extends OutlookCandidate> {
  message: T;
  /** internetMessageId when Graph gave one, else the Graph id. */
  messageId: string;
  /** Passed the rep↔lead gate. The caller reuses this; it is not recomputed. */
  isDirect: boolean;
  /** The sender is the lead — drives inbound/outbound direction downstream. */
  isFromLead: boolean;
  /** Already stored but with an empty body: re-fetched to restore it. */
  restoresPurgedBody: boolean;
}

/** internetMessageId is the stable cross-path key; fall back to the Graph id. */
export function outlookMessageId(msg: OutlookCandidate): string {
  return msg.internetMessageId || msg.id;
}

/**
 * Sort key. Messages with an unparseable or absent timestamp sort LAST rather
 * than jumping the queue.
 */
export function outlookMessageTime(msg: OutlookCandidate): number {
  const t = new Date(msg.receivedDateTime || msg.sentDateTime || "").getTime();
  return Number.isFinite(t) ? t : -Infinity;
}

function addresses(list: OutlookCandidate["toRecipients"]): string[] {
  return (list || [])
    .map((r) => r?.emailAddress?.address?.toLowerCase().trim() || "")
    .filter(Boolean);
}

/**
 * Choose which candidates to import, newest first, stopping once `limit`
 * ELIGIBLE messages have been accepted.
 *
 * Ineligible candidates never consume the budget — that is the entire point.
 * `onSkip` is optional and exists so the caller can keep logging each drop.
 *
 * Returns at most `limit` entries. Fewer means the candidate set genuinely did
 * not contain that many eligible messages; the caller's ceiling is therefore
 * how many candidates it fetched, not how it sliced them.
 */
export function selectOutlookCandidates<T extends OutlookCandidate>(
  candidates: readonly T[],
  ctx: SelectionContext,
  limit: number,
  onSkip?: (msg: T, reason: SkipReason) => void,
): Array<SelectedCandidate<T>> {
  const leadEmail = ctx.leadEmail.trim().toLowerCase();
  const repEmail = ctx.repEmail.trim().toLowerCase();

  const sorted = [...candidates].sort((a, b) => outlookMessageTime(b) - outlookMessageTime(a));

  const chosen: Array<SelectedCandidate<T>> = [];
  const seen = new Set<string>();

  for (const msg of sorted) {
    if (chosen.length >= limit) break;

    const messageId = outlookMessageId(msg);

    // The same message can surface twice in one candidate set (e.g. a copy in
    // another folder). Take it once; a second copy must not spend the budget.
    if (seen.has(messageId)) {
      onSkip?.(msg, "duplicate_in_batch");
      continue;
    }
    seen.add(messageId);

    const storedBody = ctx.bodyByMessageId.get(messageId);
    const restoresPurgedBody = ctx.alreadySyncedIds.has(messageId) &&
      (!storedBody || storedBody.trim() === "");
    if (ctx.alreadySyncedIds.has(messageId) && !restoresPurgedBody) {
      onSkip?.(msg, "already_synced");
      continue;
    }

    if (msg.isDraft) {
      onSkip?.(msg, "draft");
      continue;
    }

    const fromEmail = msg.from?.emailAddress?.address?.toLowerCase().trim() || "";
    // Any recipient field counts as "addressed to": the widened `participants:`
    // search surfaces mail where the lead or rep is only Cc'd or Bcc'd, so the
    // gate checks To + Cc + Bcc or those hits are found and then dropped.
    const recipientEmails = [
      ...addresses(msg.toRecipients),
      ...addresses(msg.ccRecipients),
      ...addresses(msg.bccRecipients),
    ];
    const isDirect = isDirectConversation({
      fromEmails: [fromEmail],
      recipientEmails,
      leadEmail,
      repEmail,
    });

    // A DSN comes FROM postmaster to the rep and names the lead only in its
    // body, so it fails the gate. Let it through — the caller's bounce handling
    // does its own attribution, and the bounce-stop is a guardrail we must not
    // miss.
    const likelyBounce = detectBounce(fromEmail, msg.subject || "").isBounce;
    if (!isDirect && !likelyBounce) {
      onSkip?.(msg, "third_party");
      continue;
    }

    const ts = outlookMessageTime(msg);
    if (Number.isFinite(ts) && ts < ctx.syncStartMs) {
      onSkip?.(msg, "too_old");
      continue;
    }

    chosen.push({
      message: msg,
      messageId,
      isDirect,
      isFromLead: fromEmail !== "" && fromEmail === leadEmail,
      restoresPurgedBody,
    });
  }

  return chosen;
}
