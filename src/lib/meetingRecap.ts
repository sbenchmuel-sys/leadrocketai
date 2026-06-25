// ============================================================================
// Meeting recap JSON parsing — shared between the Meetings tab (regenerate) and
// the "Log a meeting" dialog. Moved here VERBATIM from MeetingsTab so the logged
// meeting's AI recap/milestone parsing is byte-identical to the old inline form.
// ============================================================================

/** Strip a ```json … ``` fence (if present) and return the inner JSON string. */
export function extractJson(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

/**
 * Tolerant JSON parser: strips fences, and if the payload looks truncated
 * (starts with `{` but doesn't end with `}`), trims to the last balanced `}`
 * and retries. Returns null on unrecoverable failure.
 */
export function parseRecapJson(raw: string): Record<string, unknown> | null {
  const stripped = extractJson(raw);
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch (e1) {
    if (stripped.startsWith("{")) {
      const lastBrace = stripped.lastIndexOf("}");
      if (lastBrace > 0) {
        const candidate = stripped.slice(0, lastBrace + 1);
        try {
          return JSON.parse(candidate) as Record<string, unknown>;
        } catch (e2) {
          console.error("[meetingRecap] recap repair parse failed:", e2, candidate.slice(0, 300));
        }
      }
    }
    console.error("[meetingRecap] recap parse failed:", e1, stripped.slice(0, 300));
    return null;
  }
}
