// ============================================================
// cleanBodyText — Queue card "clean body" preview construction.
//
// The Queue card shows a 1–2 line preview under the why-now line.
// We prefer the `ai_summary` written by the inbound classifier (PR A)
// because it is already short, paraphrased and stripped of quotes.
// When `ai_summary` is missing (older inbounds before the classifier
// ran, or inbounds the classifier could not summarize), we fall back
// to `snippet_text` and strip quoted-reply blocks, signatures and
// excess whitespace so a deep historical thread doesn't fill the
// card.
//
// `subject` is the final fallback. The 72h raw-body purge nulls
// `snippet_text` on rows older than 72h while `subject` is preserved
// metadata, so without this fallback Follow-up-due cards (whose latest
// inbound is typically days old) all render "[No preview available]".
//
// Pure, no React, no DB — see cleanBodyText.test.ts.
// ============================================================

const MAX_LINES = 3;
const MAX_CHARS = 320;

const QUOTED_REPLY_HEADERS: RegExp[] = [
  // English: "On Tue, May 21, 2026 at 9:14 AM, Sam <s@x.com> wrote:" (Gmail)
  /^On\s+.+wrote:\s*$/im,
  // Outlook: "From: Name <addr>"
  /^From:\s+.+$/im,
  // Outlook block header occasionally renders without quoting: a long
  // line of underscores. Treat as a quoted-reply boundary.
  /^_{8,}\s*$/im,
  // Apple Mail: "> On May 21, 2026, at 9:14 AM, Sam wrote:"
  /^>\s*On\s+.+wrote:\s*$/im,
];

// Signature delimiter: a "--" or "—" line on its own. Some clients
// emit "-- " (dash-dash-space) per RFC 3676 §4.3; we accept any
// whitespace either side.
const SIGNATURE_DELIM = /^\s*[-—]{2,}\s*$/m;

/**
 * Strip the longest leading quoted-reply / signature block from a
 * raw email snippet so the Queue card preview shows only the new
 * content the rep needs to act on.
 */
function stripQuotesAndSignature(raw: string): string {
  let text = raw;

  // Find the earliest match of any quoted-reply header — strip from
  // there to end. Whichever header matches first wins.
  let earliest = -1;
  for (const re of QUOTED_REPLY_HEADERS) {
    const m = re.exec(text);
    if (m && m.index >= 0 && (earliest === -1 || m.index < earliest)) {
      earliest = m.index;
    }
  }
  if (earliest >= 0) {
    text = text.slice(0, earliest);
  }

  // Then strip signature block after the dash-dash line, if present.
  const sigMatch = SIGNATURE_DELIM.exec(text);
  if (sigMatch && sigMatch.index >= 0) {
    text = text.slice(0, sigMatch.index);
  }

  return text;
}

function collapseWhitespace(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // Collapse 3+ blank lines into a single blank line.
    .replace(/\n{3,}/g, "\n\n")
    // Trim trailing whitespace on every line.
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

/**
 * Truncate to at most MAX_LINES non-empty lines and MAX_CHARS total.
 * Empty leading/trailing lines are dropped; intra-block blank lines
 * are kept up to the line cap so a "Hi Sam,\n\nthanks for…" preview
 * isn't collapsed into one run-on.
 *
 * Name is historical — MAX_LINES is now 3, was 2 before pilot-mode
 * preview expansion.
 */
function clampToTwoLines(raw: string): string {
  const collected: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    collected.push(line.trim());
    if (collected.length >= MAX_LINES) break;
  }
  let out = collected.join(" ").trim();
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS - 1).trimEnd() + "…";
  }
  return out;
}

export interface CleanBodyInput {
  ai_summary?: string | null;
  snippet_text?: string | null;
  subject?: string | null;
}

/**
 * Produce the Queue card "clean body" preview from a timeline row.
 * Returns "" when all inputs are empty — caller renders the
 * "[No preview available]" placeholder.
 */
export function cleanBodyText(input: CleanBodyInput): string {
  const summary = (input.ai_summary ?? "").trim();
  if (summary) {
    // The classifier already paraphrased — just collapse whitespace
    // and clamp; no quote-stripping needed.
    return clampToTwoLines(collapseWhitespace(summary));
  }

  const snippet = (input.snippet_text ?? "").trim();
  if (snippet) {
    const stripped = stripQuotesAndSignature(snippet);
    const collapsed = collapseWhitespace(stripped);
    const clamped = clampToTwoLines(collapsed);
    if (clamped) return clamped;
    // Snippet was non-empty but reduced to nothing (signature-only,
    // quote-only). Fall through to subject.
  }

  const subject = (input.subject ?? "").trim();
  if (subject) return clampToTwoLines(collapseWhitespace(subject));

  return "";
}
