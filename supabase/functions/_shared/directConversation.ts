// ============================================================
// directConversation — the rep↔lead gate, in one pure place.
//
// A mail search for a lead's address returns far more than the
// conversation with that lead: newsletters addressed to them, a
// vendor thread that merely Cc's them, a colleague's mail. Storing
// any of that against the lead corrupts the timeline, the stage
// derivation and every outbound/inbound counter built on it.
//
// The rule: keep a message ONLY when it is lead→rep or rep→lead.
//
// Lives here (pure, no Deno/runtime imports) so a vitest spec can
// exercise the real function instead of a copy — the duplicated
// inline copies in gmail-sync / gmail-bulk-sync / outlook-sync
// drifting apart is exactly what produced the missing bulk-sync
// gate this module fixes.
// ============================================================

/**
 * True when `message` is a direct exchange between the rep's mailbox and
 * this lead.
 *
 * FAILS CLOSED. An empty `repEmail` or `leadEmail` returns false: if we do
 * not know who the rep is we cannot prove the message is theirs, and
 * attaching an unproven message to a lead is the failure this gate exists
 * to prevent. (Mirrors the existing gmail-sync behaviour, where a falsy
 * `repEmail` short-circuits both halves of the test.)
 *
 * Callers decide which headers count as "recipient": gmail paths pass To
 * only (matching gmail-sync); outlook-sync passes To + Cc + Bcc, because
 * its widened `participants:` search legitimately surfaces mail where the
 * lead or rep is only copied.
 */
export function isDirectConversation(params: {
  fromEmails: string[];
  recipientEmails: string[];
  leadEmail: string;
  repEmail: string;
}): boolean {
  const lead = norm(params.leadEmail);
  const rep = norm(params.repEmail);
  if (!lead || !rep) return false;

  const from = params.fromEmails.map(norm).filter(Boolean);
  const to = params.recipientEmails.map(norm).filter(Boolean);

  const fromLead = from.includes(lead);
  const fromRep = from.includes(rep);
  const toLead = to.includes(lead);
  const toRep = to.includes(rep);

  return (fromLead && toRep) || (fromRep && toLead);
}

function norm(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}
