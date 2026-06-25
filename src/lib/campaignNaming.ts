// ============================================
// CAMPAIGN NAMING
// Keeps two outreaches in the same workspace from sharing a name. A starter
// cadence clones in with a fixed name ("Inbound Intro", …), so a rep who adds
// the same starter twice would otherwise end up with two identical entries that
// are impossible to tell apart in the list. dedupeCampaignName makes the second
// one "Inbound Intro 2", the third "Inbound Intro 3", and so on.
// ============================================

/**
 * Return `desired` unchanged when no existing outreach already uses it; otherwise
 * append the smallest free " N" suffix (starting at 2). Matching is
 * case-insensitive and trims surrounding whitespace, mirroring how a rep reads
 * names in the list. Pure — the caller supplies the current names.
 */
export function dedupeCampaignName(desired: string, existingNames: string[]): string {
  const base = desired.trim();
  if (!base) return base;
  const taken = new Set(
    existingNames.map((n) => (n ?? "").trim().toLowerCase()).filter(Boolean),
  );
  if (!taken.has(base.toLowerCase())) return base;
  // Bounded so a pathological name set can never spin forever.
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
