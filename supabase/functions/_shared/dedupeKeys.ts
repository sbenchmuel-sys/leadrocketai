// ============================================================
// dedupeKeys — the ONE identity a message is known by.
//
// Three places ask "is this the same message?": the key we write, the unique
// index that enforces it, and the already-synced filter that decides whether to
// fetch it again. They must give the same answer. Every defect in this area so
// far has been two of the three disagreeing.
//
// ── Why the Outlook key is SCOPED ────────────────────────────────────────────
//
// `internetMessageId` is the RFC 2822 Message-ID. It is globally shared: when
// one sender emails two DrivePilot customers, BOTH copies carry the same
// Message-ID. The unscoped key `outlook:<Message-ID>` therefore collided across
// tenants, and `interactions.dedupe_key` is GLOBALLY unique — so the second
// workspace's insert raised 23505, `createCanonicalInteraction` resolved it to
// the FIRST workspace's interaction row, and projected that foreign interaction
// id into the second lead's timeline. A cross-tenant write.
//
// The scope is the LEAD, not the workspace. Workspace scoping closes the
// cross-tenant case but leaves a real same-workspace one: a rep emailing two
// leads at one company produces a single message that is a legitimate direct
// conversation with BOTH, so both leads' syncs would build the same key and the
// second would again resolve to the first's interaction row. Lead scoping
// closes both, and it matches what the timeline already enforces —
// `lead_timeline_items` is unique on (lead_id, dedupe_key), i.e. lead-scoped all
// along. It was only `interactions`' global index that was broader than the
// identity it was indexing.
//
// Scoping by lead does NOT weaken the unification this unit exists for: the
// webhook and outlook-sync store the same message against the same lead, so
// they still collapse onto one row. It only stops two DIFFERENT leads being
// forced to share one.
//
// ponytail: the Gmail/WhatsApp/call/meeting key builders still live in
// `timelineProjector.ts`. Gmail needs no scoping (its message ids are
// per-mailbox, not global), so there is no defect driving a move; they migrate
// here when their owners next touch them.
// ============================================================

/** Prefix every Outlook key carries, before the lead scope. */
const OUTLOOK_PREFIX = "outlook";

/**
 * Build the dedupe key for one Outlook email on one lead.
 *
 * BOTH Outlook writers call this — `outlook-sync` and the `outlook-webhook`
 * processor — so the same message stored by either path lands on one row.
 *
 * Shape:
 *   internetMessageId present → `outlook:<leadId>:<Message-ID>`
 *   else graph id present     → `outlook:<leadId>:graph:<graph id>`
 *   else                      → `outlook:<leadId>:interaction:<interaction id>`
 *
 * The graph fallback is namespaced so a Graph id can never be mistaken for a
 * Message-ID, and the two can never collide.
 */
export function outlookEmailDedupeKey(
  leadId: string,
  internetMessageId: string | null,
  graphMessageId: string | null,
  interactionId: string,
): string {
  const scope = `${OUTLOOK_PREFIX}:${leadId}`;
  if (internetMessageId) return `${scope}:${internetMessageId}`;
  if (graphMessageId) return `${scope}:graph:${graphMessageId}`;
  return `${scope}:interaction:${interactionId}`;
}

/**
 * True when `key` is an Outlook email key scoped to `leadId`.
 *
 * Used by the sync's already-synced filter: it asks "do we already hold this
 * message?" using THE SAME identity the insert uses, rather than a
 * provider-specific column. Asking a different question there is what let
 * webhook-ingested messages look new on every sync.
 */
export function isOutlookKeyForLead(key: string, leadId: string): boolean {
  return key.startsWith(`${OUTLOOK_PREFIX}:${leadId}:`);
}
