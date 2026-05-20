/**
 * Shared Zoom recap / AI Companion email detection.
 *
 * Extracted from the private `isZoomSummaryEmail()` function in
 * supabase/functions/process-zoom-summary/index.ts (~lines 40–67).
 * Logic is identical. Phase 2a will switch process-zoom-summary to
 * import from this module; until then it keeps its inline copy and
 * this module is consumed by the
 * `classify-timeline-intent-backfill` edge function only.
 *
 * Decision rule: (fromZoom AND subjectMatch)
 *             OR (fromZoom AND bodyMatch ≥ 2)
 *             OR (subjectMatch AND bodyMatch ≥ 2).
 */

const ZOOM_FROM_DOMAINS = ["@zoom.us", "@zoom.com"];

const ZOOM_SUBJECT_KEYWORDS = [
  "meeting summary",
  "ai companion",
  "zoom ai companion",
];

const ZOOM_BODY_KEYWORDS = [
  "meeting summary",
  "key takeaways",
  "action items",
  "next steps",
  "topics discussed",
  "ai companion",
];

export interface ZoomRecapResult {
  isZoomRecap: boolean;
}

export function detectZoomRecap(
  fromEmail: string,
  subject: string,
  bodyText: string,
): ZoomRecapResult {
  const fromLower = (fromEmail || "").toLowerCase();
  const subjectLower = (subject || "").toLowerCase();
  const bodyLower = (bodyText || "").toLowerCase();

  const isFromZoom = ZOOM_FROM_DOMAINS.some((d) => fromLower.includes(d));
  const hasSubjectMatch = ZOOM_SUBJECT_KEYWORDS.some((kw) => subjectLower.includes(kw));

  const bodyMatchCount = ZOOM_BODY_KEYWORDS.reduce(
    (n, kw) => n + (bodyLower.includes(kw) ? 1 : 0),
    0,
  );
  const hasBodyMatch = bodyMatchCount >= 2;

  const isZoomRecap =
    (isFromZoom && hasSubjectMatch) ||
    (isFromZoom && hasBodyMatch) ||
    (hasSubjectMatch && hasBodyMatch);

  return { isZoomRecap };
}
