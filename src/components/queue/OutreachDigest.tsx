// ============================================================================
// OutreachDigest — the daily summary strip at the top of the Outreach tab.
//
// Three lines, in plain words: what's due today (now + later, per channel), what
// got auto-skipped yesterday and why, and what's overdue. Collapsible; the
// rep's choice is remembered per browser. Data: src/lib/outreachDigest.ts.
// ============================================================================

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, SkipForward, CalendarCheck } from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { OUTREACH_CHANNELS, type OutreachChannel } from "@/lib/outreachQueue";
import { CHANNEL_LABEL } from "@/lib/outreachToday";
import { fetchOutreachDigest, type OutreachDigest as Digest } from "@/lib/outreachDigest";

const COLLAPSE_KEY = "outreach_digest_collapsed";

/** "3 calls · 2 emails" — non-zero channels only, in channel order. */
function channelSummary(counts: Record<OutreachChannel, number>): string {
  const parts = OUTREACH_CHANNELS.filter((ch) => counts[ch] > 0).map((ch) => `${counts[ch]} ${CHANNEL_LABEL[ch]}`);
  return parts.length ? parts.join(" · ") : "none";
}

interface OutreachDigestProps {
  /** Due-now counts per channel — the same numbers the chips show. */
  dueNow: Record<OutreachChannel, number>;
  /** Bump to re-fetch (e.g. after a card action). */
  refreshKey: number;
  onOpenChannel: (ch: OutreachChannel) => void;
}

export function OutreachDigest({ dueNow, refreshKey, onOpenChannel }: OutreachDigestProps) {
  const { workspaceTimezone } = useWorkspace();
  const [digest, setDigest] = useState<Digest | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });

  useEffect(() => {
    let cancelled = false;
    fetchOutreachDigest(workspaceTimezone)
      .then((d) => { if (!cancelled) setDigest(d); })
      .catch(() => { /* non-fatal — the list below still renders */ });
    return () => { cancelled = true; };
  }, [workspaceTimezone, refreshKey]);

  const toggle = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1"); } catch { /* ignore */ }
      return !c;
    });
  };

  const dueNowTotal = OUTREACH_CHANNELS.reduce((n, ch) => n + dueNow[ch], 0);
  const laterTotal = digest ? OUTREACH_CHANNELS.reduce((n, ch) => n + digest.laterToday[ch], 0) : 0;
  const overdueTotal = digest?.overdueTotal ?? 0;
  const skippedTotal = digest?.skippedYesterdayTotal ?? 0;

  // The oldest overdue channel is the most useful jump.
  const firstOverdueChannel = digest ? OUTREACH_CHANNELS.find((ch) => digest.overdue[ch] > 0) : undefined;

  return (
    <section className="rounded-md border border-border bg-muted/30 text-xs" aria-label="Today's outreach digest">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className="font-medium text-foreground">Today</span>
        <span className="truncate text-muted-foreground">
          {dueNowTotal} due now{laterTotal > 0 ? ` · ${laterTotal} later today` : ""}
          {overdueTotal > 0 ? ` · ${overdueTotal} overdue` : ""}
          {skippedTotal > 0 ? ` · ${skippedTotal} auto-skipped yesterday` : ""}
        </span>
      </button>

      {!collapsed && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2 text-muted-foreground">
          <div className="flex items-start gap-2">
            <CalendarCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <span className="text-foreground">Due now:</span> {channelSummary(dueNow)}
              {digest && laterTotal > 0 && (
                <> · <span className="text-foreground">later today:</span> {channelSummary(digest.laterToday)}</>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2">
            <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${overdueTotal > 0 ? "text-amber-600" : ""}`} />
            <div>
              <span className="text-foreground">Overdue:</span>{" "}
              {digest == null ? "…" : overdueTotal === 0 ? "nothing — you're caught up." : (
                <>
                  {channelSummary(digest.overdue)} still waiting from before today.
                  {firstOverdueChannel && (
                    <>
                      {" "}
                      <button type="button" className="text-primary hover:underline" onClick={() => onOpenChannel(firstOverdueChannel)}>
                        Open the {CHANNEL_LABEL[firstOverdueChannel]} queue
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2">
            <SkipForward className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <span className="text-foreground">Auto-skipped yesterday:</span>{" "}
              {digest == null ? "…" : skippedTotal === 0 ? "nothing." : (
                <ul className="mt-0.5 space-y-0.5">
                  {digest.skippedYesterday.map((g) => (
                    <li key={g.reason}>
                      {g.count} {g.count === 1 ? "step" : "steps"} — {g.reason}
                      {g.leadNames.length > 0 && (
                        <span className="text-muted-foreground/80">
                          {" "}({g.leadNames.join(", ")}{g.count > g.leadNames.length ? ", …" : ""})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
