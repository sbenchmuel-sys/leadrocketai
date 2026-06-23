// Display-only helpers for the lead conversation timeline (Unit 2).
// None of these mutate stored data — they only clean up what's shown on screen.

// Well-known confidentiality / legal footer openers. Conservative on purpose:
// we only cut when one of these clearly-boilerplate markers appears, and never
// when it's the very first thing in the message (that would blank a body that
// is itself just a notice).
const DISCLAIMER_MARKERS: RegExp[] = [
  /confidentiality notice/i,
  /this (?:e-?mail|email|message)(?: and any (?:attachments|files))?[^.\n]{0,80}\b(?:is|are|may be)\b[^.\n]{0,40}\bconfidential\b/i,
  /this (?:e-?mail|email|message) and any (?:attachments|files)/i,
  /the (?:information|contents?)[^.\n]{0,60}(?:contained )?in this (?:e-?mail|email|message)[^.\n]{0,80}(?:confidential|privileged)/i,
  /if you are not the intended recipient/i,
  /this (?:transmission|communication)[^.\n]{0,60}(?:confidential|privileged)/i,
  /please consider the environment before printing/i,
  /^\s*disclaimer\s*:/im,
  /\bNOTICE\b\s*:\s*This (?:e-?mail|email|message|communication)/i,
];

/**
 * Strip a standard email confidentiality/legal footer from a body for DISPLAY.
 * Returns the text up to the earliest disclaimer marker (trimmed). If no marker
 * is found, or a marker sits at the very start, the text is returned unchanged.
 */
export function stripEmailDisclaimer(text: string | null | undefined): string {
  if (!text) return "";
  let cut = -1;
  for (const re of DISCLAIMER_MARKERS) {
    const m = re.exec(text);
    if (m && m.index > 0 && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut === -1) return text;
  const kept = text.slice(0, cut).replace(/[\s>*_=:-]+$/, "").trimEnd();
  // Only strip when there's a real message before the disclaimer — otherwise a
  // body that's nothing but a notice (or a stray mid-sentence match) would be
  // mangled down to a label. Require at least 3 words of kept content.
  const words = kept.trim() ? kept.trim().split(/\s+/).length : 0;
  return words >= 3 ? kept : text;
}

/**
 * Compact relative time: "just now", "5m ago", "2h ago", "3d ago", "2w ago".
 * Anything older than ~4 weeks (or any future date) shows a plain date.
 * The exact timestamp stays available as a tooltip at the call site.
 */
export function relativeTimeShort(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const ms = Date.now() - d.getTime();
  const asDate = () => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (Number.isNaN(d.getTime())) return "";
  if (ms < 0) return asDate(); // future (e.g. an upcoming meeting)
  const sec = Math.floor(ms / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 28) return `${Math.floor(day / 7)}w ago`;
  return asDate();
}

const GREETING_LINE = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b/i;

/**
 * First substantive line of a message, for the collapsed one-line gist.
 * Skips a leading short greeting ("Hi Kenneth,") so the gist carries meaning;
 * never skips more than the greeting. CSS still clamps the final width.
 */
export function oneLineGist(text: string | null | undefined): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  for (const line of lines) {
    if (GREETING_LINE.test(line) && line.length < 40) continue;
    return line;
  }
  return lines[0];
}
