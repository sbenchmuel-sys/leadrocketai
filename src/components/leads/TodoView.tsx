// ============================================================================
// TodoView — the "To-do" tab on the merged /app/leads page (Unit B).
//
// A flat, read-only mirror of the items the Queue already surfaces for the
// logged-in rep. It calls the Queue's own data layer (fetchQueueLeads) and
// renders a scannable list — it does NOT change how the Queue ranks or
// generates items, and it builds no new compose/draft surface. "Open" hands
// the rep into the Queue's existing focused Lead Detail flow (originContext
// "queue"), exactly as the Queue card does.
//
// Channel (email vs call): every reactive Queue item today is an email action.
// Tagging items as "better to call" touches the Queue's brain and ships in a
// later unit — until then channelOf() returns "email" for everything, the Call
// pill counts 0 and is hidden. We do NOT invent a call heuristic here.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Mail, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fetchQueueLeads,
  chipForLead,
  leadWasAway,
  type QueueLeadRow,
} from "@/lib/queueQueries";
import { ShowMoreFooter } from "@/components/leads/ShowMoreFooter";

type Channel = "email" | "call";
type ChannelFilter = "all" | Channel;

const TODO_PAGE_SIZE = 25;

/** Forward-compatible channel read. No call signal exists yet → all email. */
function channelOf(lead: QueueLeadRow): Channel {
  const key = lead.next_action_key ?? "";
  if (key.startsWith("call_") || key === "call_now") return "call";
  return "email";
}

/** Compact, plain relative time — no seconds, no jargon. */
function compactAgo(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * The "why now" line — pulled from the same signal the Queue ranks on
 * (the action key bucket + last inbound/outbound time). Plain sales
 * language, one line, no internal status words.
 */
function whyNow(lead: QueueLeadRow): string {
  if (leadWasAway({ next_action_key: lead.next_action_key })) return "Back from time away";

  const bucket = chipForLead({
    next_action_key: lead.next_action_key,
    action_resurfaced_at: lead.action_resurfaced_at,
  });

  if (bucket === "replied") {
    const ago = compactAgo(lead.last_inbound_at);
    return ago ? `Replied ${ago}` : "Customer replied";
  }

  // Follow-up → how long it's been quiet since we last reached out.
  const days = daysSince(lead.last_outbound_at ?? lead.last_inbound_at);
  if (days != null) {
    if (days <= 0) return "Quiet since today";
    return `Quiet for ${days} day${days === 1 ? "" : "s"}`;
  }
  return "Needs a follow-up";
}

/** The one thing to do, from the Queue's own label (lower-cased after the dash). */
function actionText(lead: QueueLeadRow): string {
  const label = lead.next_action_label?.trim();
  if (label) return label.charAt(0).toLowerCase() + label.slice(1);
  const bucket = chipForLead({
    next_action_key: lead.next_action_key,
    action_resurfaced_at: lead.action_resurfaced_at,
  });
  return bucket === "replied" ? "reply to customer" : "follow up";
}

export function TodoView() {
  const [leads, setLeads] = useState<QueueLeadRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<ChannelFilter>("all");
  const [visibleCount, setVisibleCount] = useState(TODO_PAGE_SIZE);

  useEffect(() => {
    let cancelled = false;
    fetchQueueLeads()
      .then(({ leads }) => {
        if (!cancelled) setLeads(leads);
      })
      .catch(() => {
        if (!cancelled) setLeads([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    let email = 0;
    let call = 0;
    for (const l of leads) {
      if (channelOf(l) === "call") call += 1;
      else email += 1;
    }
    return { all: leads.length, email, call };
  }, [leads]);

  const visible = useMemo(
    () => (filter === "all" ? leads : leads.filter((l) => channelOf(l) === filter)),
    [leads, filter],
  );

  // Reset paging when the channel filter changes.
  useEffect(() => {
    setVisibleCount(TODO_PAGE_SIZE);
  }, [filter]);

  const pageItems = useMemo(() => visible.slice(0, visibleCount), [visible, visibleCount]);

  const pillClass = (active: boolean) =>
    cn(
      "rounded-full px-3 py-1 text-xs font-medium",
      active
        ? "border border-border bg-background text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {/* Filter pills — light gray header strip */}
      <div className="flex items-center gap-2 bg-muted/50 px-4 py-2.5">
        <button type="button" onClick={() => setFilter("all")} className={pillClass(filter === "all")}>
          All · {counts.all}
        </button>
        <button type="button" onClick={() => setFilter("email")} className={pillClass(filter === "email")}>
          Email · {counts.email}
        </button>
        {/* Call pill hidden entirely when there are no call items (expected today). */}
        {counts.call > 0 && (
          <button type="button" onClick={() => setFilter("call")} className={pillClass(filter === "call")}>
            Call · {counts.call}
          </button>
        )}
      </div>

      {/* Item rows */}
      <div className="divide-y divide-border">
        {isLoading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {leads.length === 0 ? "You're all caught up." : "Nothing in this filter."}
          </p>
        ) : (
          pageItems.map((lead) => {
            const channel = channelOf(lead);
            return (
              <div key={lead.id} className="flex items-center gap-3 px-4 py-3">
                {channel === "call" ? (
                  <Phone className="h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <span className="font-semibold text-foreground">{lead.name}</span>
                    <span className="text-muted-foreground"> — {actionText(lead)}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{whyNow(lead)}</p>
                </div>
                <Button asChild size="sm" variant="outline" className="shrink-0">
                  <Link to={`/app/leads/${lead.id}`} state={{ originContext: "queue" }}>
                    Open
                  </Link>
                </Button>
              </div>
            );
          })
        )}
      </div>

      <ShowMoreFooter
        shown={pageItems.length}
        total={visible.length}
        pageSize={TODO_PAGE_SIZE}
        onShowMore={() => setVisibleCount((c) => c + TODO_PAGE_SIZE)}
        onShowAll={() => setVisibleCount(visible.length)}
      />
    </div>
  );
}
