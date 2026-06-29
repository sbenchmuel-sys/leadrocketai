// ============================================================================
// One-pager offer token — the send-time gate for the uploaded campaign one-pager.
//
// Zero-dependency leaf (Node/vitest-testable, like coldReplyStop.ts). At authoring
// time the campaign content carries a P.S. offer line ending in this token; at
// SEND time the link is resolved fresh — swapped for the current public URL, or the
// whole offer line is STRIPPED when no ready one-pager exists. Resolving at send
// (not baking the URL at authoring) is what guarantees a removed/never-ready file
// can never leave a dead link in a prospect's inbox.
//
// CONTRACT: the literal token string is DUPLICATED in the client authoring path
// (src/lib/generateCampaignContent.ts ONE_PAGER_LINK_TOKEN) because client (Vite)
// and edge (Deno) can't share a module. Keep both in sync if it ever changes.
// ============================================================================

export const ONE_PAGER_LINK_TOKEN = "{{ONE_PAGER_LINK}}";

/**
 * Resolve the one-pager offer at send time.
 *  - body without the token → returned unchanged.
 *  - url present → every token replaced with the public link.
 *  - url null/blank → every LINE containing the token is removed (blank runs tidied),
 *    so no dead link and no dangling "P.S. …" fragment is sent.
 */
export function applyOnePagerToken(body: string, url: string | null): string {
  if (!body || !body.includes(ONE_PAGER_LINK_TOKEN)) return body;
  if (url && url.trim()) return body.split(ONE_PAGER_LINK_TOKEN).join(url.trim());
  const kept = body.split("\n").filter((line) => !line.includes(ONE_PAGER_LINK_TOKEN));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t\n]+$/g, "");
}
