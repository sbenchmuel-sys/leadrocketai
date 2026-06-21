// ============================================================================
// Cold-send floor — PURE decision rules (zero-dependency leaf)
//
// The fail-closed floor in coldOutreach.ts (coldSendFloor / sendColdEmailTouch)
// does database I/O, so it can only run under Deno. These are the two PURE pieces
// of that floor's decision — email-sendability and suppression-list matching —
// pulled into their own zero-import module so the Node/vitest suite can unit-test
// them directly, exactly like coldReplyStop.ts in Unit 1. coldOutreach.ts imports
// them back, so the behavior is unchanged — this file is the single source of truth
// for both rules.
//
// Nothing here touches the network, the database, Deno, or supabase-js.
// ============================================================================

// Mirrors src/lib/emailValidation.ts isValidEmail — the validator the import +
// enrollment use to admit a lead. Deno can't import the frontend module, so this is
// the established frontend/_shared duplication; KEEP IN SYNC. The floor is the LAST
// guard before an automatic or review cold send, so it must be no weaker than the
// gate that let the address in — otherwise invalid data edited in afterward
// (person@-example.com, person@example-.com, an over-long local part) would slip past
// every check and send.
const COLD_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// RFC 1123 DNS label: alphanumeric ends, only alphanumerics + hyphen between.
const COLD_DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

export function isSendableColdEmail(raw: string): boolean {
  const e = (raw || "").trim();
  if (!e || e.length > 254) return false;
  if (!COLD_EMAIL_RE.test(e)) return false;
  if (e.includes("..")) return false; // consecutive dots
  const [local, domain] = e.split("@");
  if (!local || local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false; // dot can't bound the local part
  if (!domain) return false;
  // Validate EVERY domain label against DNS hostname syntax. Checking only the WHOLE
  // domain's first/last char misses an invalid intermediate label (foo-.example.com),
  // and the loose regex above admits non-DNS chars (exa_mple.com, foo!.com) — both
  // would pass the fail-closed floor. The label regex also rejects empty labels.
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length > 63 || !COLD_DNS_LABEL_RE.test(label)) return false;
  }
  return true;
}

/** One row of the workspace do-not-contact / suppression list. */
export interface SuppressionRow {
  kind: string;
  value: string;
}

/**
 * True when the lead is on the workspace suppression list — matched EXACTLY, by
 * email OR by domain, with the kind and value paired. A `kind:"email"` row only
 * suppresses on an exact email match and a `kind:"domain"` row only on an exact
 * domain match (so an email-kind row holding a bare domain does NOT block the
 * whole domain, and vice-versa). Both `email` and `domain` must be pre-normalized
 * (trimmed + lowercased) by the caller, as coldSendFloor does.
 */
export function isColdSuppressed(email: string, domain: string, rows: SuppressionRow[]): boolean {
  return (rows || []).some(
    (r) => (r.kind === "email" && r.value === email) || (r.kind === "domain" && r.value === domain),
  );
}
