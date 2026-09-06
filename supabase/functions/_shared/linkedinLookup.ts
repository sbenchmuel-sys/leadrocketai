// ============================================================
// linkedinLookup — pick a lead's LinkedIn profile out of web-search results.
//
// Fail-closed by design: we only ever save a URL when exactly ONE profile in
// the results carries the lead's full name (and, when more than one does, the
// company breaks the tie). Anything ambiguous returns null and the lead simply
// keeps skipping its LinkedIn touches the way it did before — a wrong profile
// on a lead is worse than none (the rep would message a stranger).
// Pure; tested in linkedinLookup.test.ts.
// ============================================================
import type { SearchResult } from "./webSearch.ts";

/** The search we run: profile pages only, the name quoted, the company quoted when known. */
export function linkedinSearchQuery(name: string, company: string | null): string {
  const q = `site:linkedin.com/in "${name.trim()}"`;
  const c = (company || "").trim();
  return c ? `${q} "${c}"` : q;
}

const PROFILE_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i;

/** Canonical "https://www.linkedin.com/in/<slug>" or null for a non-profile link. */
export function normalizeProfileUrl(link: string): string | null {
  const m = PROFILE_RE.exec(link.trim());
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).toLowerCase();
  if (!slug) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

function tokens(s: string): string[] {
  // NFKD splits accents into combining marks; drop the marks (\p{M}) so "José"
  // matches "Jose", then treat any other non-letter as a word break.
  return s.toLowerCase().normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter(Boolean);
}

/** Every token of `needle` appears in `hay` (word-level, accent/case-insensitive). */
function containsAllTokens(hay: string, needle: string): boolean {
  const hayTokens = new Set(tokens(hay));
  const need = tokens(needle);
  return need.length > 0 && need.every((t) => hayTokens.has(t));
}

/**
 * The single profile URL we're confident is this person, or null.
 *  1. Keep only linkedin.com/in/ links whose TITLE contains every token of the
 *     lead's name (LinkedIn titles are "First Last - Title - Company | LinkedIn").
 *  2. One distinct profile → that's them.
 *  3. Several → keep the ones whose title/snippet mention the company; exactly
 *     one left → that's them. Otherwise null.
 */
export function pickLinkedinProfile(
  results: SearchResult[],
  name: string,
  company: string | null,
): string | null {
  const byUrl = new Map<string, SearchResult[]>();
  for (const r of results) {
    const url = normalizeProfileUrl(r.link);
    if (!url) continue;
    if (!containsAllTokens(r.title, name)) continue;
    byUrl.set(url, [...(byUrl.get(url) ?? []), r]);
  }
  if (byUrl.size === 0) return null;
  if (byUrl.size === 1) return [...byUrl.keys()][0];

  const c = (company || "").trim();
  if (!c) return null;
  const withCompany = [...byUrl.entries()].filter(([, rs]) =>
    rs.some((r) => containsAllTokens(`${r.title} ${r.snippet}`, c)),
  );
  return withCompany.length === 1 ? withCompany[0][0] : null;
}
