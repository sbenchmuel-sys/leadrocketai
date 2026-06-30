// Canonical merge-field tokens for campaign content authored by reps.
// Format matches what `ai_task` normalises at send time
// (see normalizeCampaignTemplatePlaceholders in supabase/functions/ai_task), so
// anything inserted here flows through the existing live-send pipeline.

export interface MergeField {
  token: string;
  label: string;
  /** Show only on email steps (e.g. {MeetingLink}). */
  emailOnly?: boolean;
}

export const MERGE_FIELDS: MergeField[] = [
  { token: "{FirstName}", label: "First name" },
  { token: "{LastName}", label: "Last name" },
  { token: "{Company}", label: "Company" },
  { token: "{Industry}", label: "Industry" },
  { token: "{RepFirstName}", label: "Rep first name" },
  { token: "{MeetingLink}", label: "Meeting link", emailOnly: true },
];

export function fieldsForChannel(channel: string): MergeField[] {
  if (channel === "email") return MERGE_FIELDS;
  return MERGE_FIELDS.filter((f) => !f.emailOnly);
}

/**
 * Insert `text` at the current selection of an input/textarea, preserving the
 * surrounding value and leaving the caret right after the inserted text.
 * Returns the new value and new caret position so the caller can update React
 * state and restore selection on the next tick.
 */
export function insertAtCursor(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): { value: string; caret: number } {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const value = el.value.slice(0, start) + text + el.value.slice(end);
  return { value, caret: start + text.length };
}

/**
 * Detect a `{{` trigger immediately before the caret and return the query the
 * user has typed after it (empty string right after `{{`). Returns null if the
 * caret is not inside an active `{{...}` trigger.
 */
export function detectMergeTrigger(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  // Look back for the most recent `{{` on the same logical span (no whitespace
  // break and no closing brace).
  const head = value.slice(0, caret);
  const open = head.lastIndexOf("{{");
  if (open === -1) return null;
  const between = head.slice(open + 2);
  if (/[\s}]/.test(between)) return null;
  return { query: between, start: open };
}
