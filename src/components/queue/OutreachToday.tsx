// ============================================================================
// OutreachToday — the Outreach tab's "Today" view (Sprint 3).
//
// Replaces the single flat oldest-first list with:
//   • Channel chips — All / Email / Call / Text / WhatsApp / LinkedIn, each with the
//     TRUE backlog count for that channel (server HEAD counts, not the page), so a
//     rep can work one channel at a time the way they actually do it (all the calls
//     in one sitting, all the LinkedIn touches in one tab).
//   • "All" groups the page's cards under channel headers, oldest-due first inside
//     each group; a group header shows how many are due in that channel overall
//     and jumps to that channel's queue.
//   • Focus mode — one card at a time for the selected queue, with "N of M" and
//     Prev/Next. Every action (Send / handled / skip / snooze) removes the card, so
//     the next one slides in without the rep touching anything else.
//
// The data source is unchanged (fetchOutreachQueue, owner-scoped, paged); this
// component only decides how to lay it out. Paging is the parent's "Show more"
// window — focus mode pulls the next page when it runs off the end.
// ============================================================================

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Mail, PhoneCall, Phone, MessageSquare, Linkedin, ChevronLeft, ChevronRight, Crosshair, X } from "lucide-react";
import { OutreachCard } from "@/components/queue/OutreachCard";
import { QueueEmptyState } from "@/components/queue/QueueEmptyState";
import { OUTREACH_CHANNELS, type OutreachChannel, type OutreachTouch } from "@/lib/outreachQueue";
import { CHANNEL_LABEL, groupByChannel } from "@/lib/outreachToday";

const CHANNEL_ICON: Record<OutreachChannel, ReactNode> = {
  email: <Mail className="h-3.5 w-3.5" />,
  voice: <PhoneCall className="h-3.5 w-3.5" />,
  sms: <Phone className="h-3.5 w-3.5" />,
  whatsapp: <MessageSquare className="h-3.5 w-3.5" />,
  linkedin: <Linkedin className="h-3.5 w-3.5" />,
};

interface OutreachTodayProps {
  touches: OutreachTouch[];
  /** Backlog size for the CURRENT selection (all, or the selected channel). */
  total: number;
  /** Backlog size per channel — the chip counts. */
  byChannel: Record<OutreachChannel, number>;
  loading: boolean;
  channel: OutreachChannel | null;
  onSelectChannel: (ch: OutreachChannel | null) => void;
  /** Grow the page window; null when every due touch is already on screen. */
  onShowMore: (() => void) | null;
  onDone: (touchId: string) => void;
  onRestore: (touchId: string) => void;
}

export function OutreachToday({
  touches, total, byChannel, loading, channel, onSelectChannel, onShowMore, onDone, onRestore,
}: OutreachTodayProps) {
  const [focus, setFocus] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);

  // Leaving a channel (or the list draining) resets the cursor so it never points
  // past the end of a different queue.
  useEffect(() => { setFocusIdx(0); }, [channel]);
  const safeIdx = Math.min(focusIdx, Math.max(0, touches.length - 1));
  // Focus mode ran off the loaded page but the backlog has more → pull the next page.
  // Guarded on the page actually having GROWN since the last pull, so a server total
  // that's drifted above what the query returns can't spin this into a request loop.
  const lastPullAt = useRef(-1);
  useEffect(() => {
    if (!focus) { lastPullAt.current = -1; return; }
    if (loading || touches.length === 0 || safeIdx < touches.length - 1) return;
    if (touches.length >= total || !onShowMore) return;
    if (lastPullAt.current === touches.length) return;
    lastPullAt.current = touches.length;
    onShowMore();
  }, [focus, loading, safeIdx, touches.length, total, onShowMore]);

  const allCount = OUTREACH_CHANNELS.reduce((n, ch) => n + byChannel[ch], 0);
  const chips: { id: OutreachChannel | null; label: string; count: number; icon?: ReactNode }[] = [
    { id: null, label: "All", count: allCount },
    ...OUTREACH_CHANNELS.map((ch) => ({ id: ch, label: CHANNEL_LABEL[ch], count: byChannel[ch], icon: CHANNEL_ICON[ch] })),
  ];

  const chipRow = (
    <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Outreach channel">
      {chips.map((chip) => {
        const isActive = channel === chip.id;
        return (
          <Button
            key={chip.id ?? "all"}
            type="button"
            variant={isActive ? "default" : "outline"}
            size="sm"
            aria-pressed={isActive}
            disabled={!isActive && chip.count === 0 && chip.id !== null}
            onClick={() => onSelectChannel(chip.id)}
            className={cn(
              "h-8 shrink-0 gap-1.5 rounded-full px-3 text-xs font-medium",
              isActive ? "" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {chip.icon}
            <span>{chip.label}</span>
            <Badge
              variant="secondary"
              className={cn(
                "px-1.5 py-0 text-[10px] tabular-nums",
                isActive ? "bg-primary-foreground/20 text-primary-foreground" : "",
              )}
            >
              {chip.count}
            </Badge>
          </Button>
        );
      })}
      <div className="ml-auto shrink-0">
        <Button
          type="button"
          size="sm"
          variant={focus ? "secondary" : "ghost"}
          className="h-8 gap-1.5 text-xs"
          disabled={total === 0 && !focus}
          onClick={() => { setFocus((f) => !f); setFocusIdx(0); }}
          aria-pressed={focus}
          title={focus ? "Back to the list" : "Work this queue one card at a time"}
        >
          {focus ? <X className="h-3.5 w-3.5" /> : <Crosshair className="h-3.5 w-3.5" />}
          {focus ? "Exit focus" : "Focus mode"}
        </Button>
      </div>
    </div>
  );

  const skeleton = (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-card/40" />
      ))}
    </div>
  );

  const showMore = touches.length < total && onShowMore && (
    <div className="flex items-center justify-center gap-3 pt-1">
      <span className="text-xs text-muted-foreground">Showing {touches.length} of {total}</span>
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onShowMore}>Show more</Button>
    </div>
  );

  // ── Focus mode: one card, a cursor, and nothing else on screen ──
  if (focus) {
    const current = touches[safeIdx];
    const queueName = channel ? `${CHANNEL_LABEL[channel]} queue` : "All outreach";
    return (
      <div className="space-y-3">
        {chipRow}
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {queueName} · {total === 0 ? "nothing due" : `${Math.min(safeIdx + 1, total)} of ${total}`}
          </span>
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Previous card"
              disabled={safeIdx === 0} onClick={() => setFocusIdx((i) => Math.max(0, i - 1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Next card"
              disabled={safeIdx >= touches.length - 1} onClick={() => setFocusIdx((i) => i + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {loading && touches.length === 0 ? skeleton
          : !current ? <QueueEmptyState variant="no_matches" />
          : <OutreachCard key={current.id} touch={current} onDone={onDone} onRestore={onRestore} />}
      </div>
    );
  }

  // ── One channel: a plain oldest-first list for that queue ──
  if (channel) {
    return (
      <div className="space-y-3">
        {chipRow}
        {loading && touches.length === 0 ? skeleton
          : touches.length === 0 ? <QueueEmptyState variant="no_matches" />
          : (
            <div className="space-y-2">
              {touches.map((t) => <OutreachCard key={t.id} touch={t} onDone={onDone} onRestore={onRestore} />)}
              {showMore}
            </div>
          )}
      </div>
    );
  }

  // ── All: the page grouped under channel headers ──
  const groups = groupByChannel(touches);
  return (
    <div className="space-y-3">
      {chipRow}
      {loading && touches.length === 0 ? skeleton
        : groups.length === 0 ? <QueueEmptyState variant="no_matches" />
        : (
          <div className="space-y-4">
            {groups.map((g) => (
              <section key={g.channel} aria-label={`${CHANNEL_LABEL[g.channel]} touches`}>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                    {CHANNEL_ICON[g.channel]} {CHANNEL_LABEL[g.channel]}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">{byChannel[g.channel]} due</span>
                  {byChannel[g.channel] > g.touches.length && (
                    <button type="button" className="text-xs text-primary hover:underline"
                      onClick={() => onSelectChannel(g.channel)}>
                      Open this queue
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {g.touches.map((t) => <OutreachCard key={t.id} touch={t} onDone={onDone} onRestore={onRestore} />)}
                </div>
              </section>
            ))}
            {showMore}
          </div>
        )}
    </div>
  );
}
