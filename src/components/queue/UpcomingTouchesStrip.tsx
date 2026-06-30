// ============================================================================
// UpcomingTouchesStrip — forward-looking surface of scheduled cold touches in
// the Queue → Outreach tab. Grouped by campaign so enrolling 100 leads collapses
// into one row. Click a row to expand the per-lead list inline (capped at 50);
// "Show all" opens a drawer with the full list for that campaign.
// ============================================================================

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Mail, Phone, MessageSquare, Linkedin, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  fetchUpcomingTouches,
  formatReadyAt,
  type UpcomingCampaignGroup,
  type UpcomingChannel,
} from "@/lib/upcomingTouchesQueries";

const VISIBLE_CAP = 50;

function ChannelIcon({ channel }: { channel: UpcomingChannel }) {
  const cls = "h-3.5 w-3.5 text-muted-foreground shrink-0";
  switch (channel) {
    case "email":    return <Mail className={cls} />;
    case "voice":    return <Phone className={cls} />;
    case "sms":      return <MessageSquare className={cls} />;
    case "whatsapp": return <MessageCircle className={cls} />;
    case "linkedin": return <Linkedin className={cls} />;
  }
}

interface Props {
  /** Bump to force a refetch (e.g. after the Outreach tab is reopened). */
  refreshKey?: number;
}

export function UpcomingTouchesStrip({ refreshKey = 0 }: Props) {
  const [groups, setGroups] = useState<UpcomingCampaignGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<UpcomingCampaignGroup | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchUpcomingTouches()
      .then((g) => { if (!cancelled) setGroups(g); })
      .catch(() => { if (!cancelled) setGroups([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (loading || groups.length === 0) return null;

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <>
      <div className="rounded-lg border border-border bg-card/40">
        <div className="px-3 py-2 border-b border-border">
          <h3 className="text-xs font-medium text-foreground">Upcoming touches</h3>
          <p className="text-[11px] text-muted-foreground">
            Scheduled cold touches waiting for their send window.
          </p>
        </div>
        <ul className="divide-y divide-border">
          {groups.map((g) => {
            const isOpen = expanded.has(g.campaignId);
            const visibleLeads = g.leads.slice(0, VISIBLE_CAP);
            const overflow = g.leads.length - visibleLeads.length;
            return (
              <li key={g.campaignId}>
                <button
                  type="button"
                  onClick={() => toggle(g.campaignId)}
                  className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
                >
                  {isOpen
                    ? <ChevronDown className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    : <ChevronRight className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground">
                      <span className="font-medium">{g.campaignName}</span>
                      <span className="text-muted-foreground"> — {g.leadCount} {g.leadCount === 1 ? "lead" : "leads"} scheduled · next ready {formatReadyAt(g.nextReadyAt)}</span>
                    </div>
                    {g.skipReasonSummary.length > 0 && (
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {g.skipReasonSummary.join(" · ")}
                      </div>
                    )}
                  </div>
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 pt-1 space-y-1">
                    {visibleLeads.map((l) => (
                      <div key={l.touchId} className="flex items-center gap-2 text-xs">
                        <ChannelIcon channel={l.channel} />
                        <span className="text-foreground truncate flex-1 min-w-0">
                          {l.leadName}
                          {l.company && <span className="text-muted-foreground"> · {l.company}</span>}
                        </span>
                        <span className="text-muted-foreground whitespace-nowrap">{formatReadyAt(l.readyAt)}</span>
                        {l.previousSkipReason && (
                          <span className="text-[10px] text-muted-foreground italic whitespace-nowrap">
                            skipped: {l.previousSkipReason}
                          </span>
                        )}
                      </div>
                    ))}
                    {overflow > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setDrawer(g)}
                      >
                        Show all {g.leadCount}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <Sheet open={drawer !== null} onOpenChange={(open) => { if (!open) setDrawer(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          {drawer && (
            <>
              <SheetHeader>
                <SheetTitle>{drawer.campaignName}</SheetTitle>
                <p className="text-xs text-muted-foreground">
                  {drawer.leadCount} scheduled · next ready {formatReadyAt(drawer.nextReadyAt)}
                </p>
              </SheetHeader>
              <ul className="mt-4 space-y-1">
                {drawer.leads.map((l) => (
                  <li key={l.touchId} className="flex items-center gap-2 text-xs py-1 border-b border-border/40">
                    <ChannelIcon channel={l.channel} />
                    <span className="text-foreground truncate flex-1 min-w-0">
                      {l.leadName}
                      {l.company && <span className="text-muted-foreground"> · {l.company}</span>}
                    </span>
                    <span className="text-muted-foreground whitespace-nowrap">{formatReadyAt(l.readyAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
