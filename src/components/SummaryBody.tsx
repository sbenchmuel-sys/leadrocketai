// SummaryBody — renders an AI summary string, treating lines that begin
// with `• `, `- `, or `* ` as a bulleted list. The lead sentence (any
// non-bullet text before the first bullet) renders as a paragraph above
// the list. Plain prose (no bullets) renders as-is with line breaks
// preserved.
//
// Used by Timeline rows (collapsed + expanded) and the Queue card so
// length-scaled summaries look the same everywhere.

import { cn } from "@/lib/utils";

const BULLET_RE = /^[\s]*[•\-*]\s+(.*)$/;

interface ParsedSummary {
  lead: string;
  bullets: string[];
  isBulleted: boolean;
}

export function parseSummary(raw: string): ParsedSummary {
  const lines = raw.split(/\r?\n/).map((l) => l.trimEnd());
  const leadLines: string[] = [];
  const bullets: string[] = [];
  let seenBullet = false;
  for (const line of lines) {
    const m = line.match(BULLET_RE);
    if (m) {
      seenBullet = true;
      const text = m[1].trim();
      if (text) bullets.push(text);
    } else if (!seenBullet) {
      if (line.trim()) leadLines.push(line.trim());
    } else if (line.trim() && bullets.length > 0) {
      // Continuation line under the last bullet (wrap).
      bullets[bullets.length - 1] += " " + line.trim();
    }
  }
  return {
    lead: leadLines.join(" "),
    bullets,
    isBulleted: seenBullet,
  };
}

interface SummaryBodyProps {
  text: string | null | undefined;
  /** Maximum bullets to render before truncating with "+ N more". 0 = unlimited. */
  maxBullets?: number;
  /** Tailwind classes applied to wrapping <div>. */
  className?: string;
  /** Tailwind classes applied to lead paragraph and bullet items. */
  textClassName?: string;
}

export function SummaryBody({
  text,
  maxBullets = 0,
  className,
  textClassName = "text-[13px] text-muted-foreground leading-relaxed",
}: SummaryBodyProps) {
  if (!text || !text.trim()) return null;
  const parsed = parseSummary(text);

  if (!parsed.isBulleted) {
    return (
      <p className={cn(textClassName, "whitespace-pre-wrap", className)}>
        {parsed.lead || text.trim()}
      </p>
    );
  }

  const visibleBullets = maxBullets > 0
    ? parsed.bullets.slice(0, maxBullets)
    : parsed.bullets;
  const hiddenCount = parsed.bullets.length - visibleBullets.length;

  return (
    <div className={cn("space-y-1", className)}>
      {parsed.lead && (
        <p className={cn(textClassName)}>{parsed.lead}</p>
      )}
      <ul className={cn("space-y-0.5 pl-1", textClassName)}>
        {visibleBullets.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-muted-foreground/60 select-none">•</span>
            <span className="flex-1">{b}</span>
          </li>
        ))}
        {hiddenCount > 0 && (
          <li className="text-muted-foreground/70 text-[12px] pl-3">
            + {hiddenCount} more
          </li>
        )}
      </ul>
    </div>
  );
}
