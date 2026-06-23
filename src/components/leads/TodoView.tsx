// ============================================================================
// TodoView — the "To-do" tab on the merged /app/leads page (Unit B + D).
//
// A flat, scannable mirror of the items the Queue surfaces for the logged-in
// rep. It calls the Queue's own data layer (fetchQueueLeads) and does NOT change
// how the Queue ranks or generates items.
//
// Unit D — fewer-clicks responding:
//   • Per-row CTA next to "Open", labeled for the next step (Reply / Follow up).
//     Clicking opens the existing email composer (EmailActionDialog) with a
//     draft already warming up — reusing the same dialog the All-leads list
//     uses. No new compose surface; the rep reviews + sends manually.
//   • Bulk "Draft emails": multi-select rows and pre-generate drafts for all of
//     them via the shared background draft queue; each row shows Drafting… →
//     Draft ready, and its CTA opens the composer with the ready draft.
//
// Guardrail: generated drafts are held + reviewed + sent by the rep — never
// handed to the automated sender.
//
// Channel (email vs call): every reactive Queue item today is an email action.
// Call items (and a call-script surface) ship in a later unit — channelOf()
// returns "email" for everything today, so the Call pill counts 0 and is hidden
// and the per-row CTA opens the email composer. We do NOT invent a call path.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Mail, Phone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  fetchQueueLeads,
  chipForLead,
  leadWasAway,
  queueButtonLabel,
  type QueueLeadRow,
} from "@/lib/queueQueries";
import { ShowMoreFooter } from "@/components/leads/ShowMoreFooter";
import { useBackgroundDraftQueue } from "@/hooks/useBackgroundDraftQueue";
import { EmailActionDialog } from "@/components/dashboard/EmailActionDialog";

type Channel = "email" | "call";
type ChannelFilter = "all" | Channel;

const TODO_PAGE_SIZE = 25;
// Matches MAX_CONCURRENT in useBackgroundDraftQueue — draft at most this many at
// once so the overflow isn't silently dropped.
const MAX_BULK_DRAFT = 20;

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

/** CTA label: "Reply" for customer-waiting, "Follow up" otherwise, "Call" for call items. */
function ctaLabel(lead: QueueLeadRow): string {
  if (channelOf(lead) === "call") return "Call";
  return queueButtonLabel({
    next_action_key: lead.next_action_key,
    action_resurfaced_at: lead.action_resurfaced_at,
  });
}

export function TodoView() {
  const [leads, setLeads] = useState<QueueLeadRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<ChannelFilter>("all");
  const [visibleCount, setVisibleCount] = useState(TODO_PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Shared background draft queue (same one All-leads + the Queue use).
  const { enqueue, getStatus, consume } = useBackgroundDraftQueue();

  // Composer dialog state.
  const [composerLead, setComposerLead] = useState<QueueLeadRow | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const loadTodos = useCallback(async () => {
    try {
      const { leads: rows } = await fetchQueueLeads();
      setLeads(rows);
    } catch {
      /* keep the current list on a transient error */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchQueueLeads()
      .then(({ leads: rows }) => {
        if (!cancelled) setLeads(rows);
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

  // Drop stale selections when the underlying list changes.
  useEffect(() => {
    setSelectedIds((prev) => {
      const ids = new Set(leads.map((l) => l.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [leads]);

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ── Quick actions ──────────────────────────────────────────────────────
  const handleBulkDraft = () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    // The background draft queue caps active drafts. Draft up to that many now
    // and KEEP the overflow selected for a second batch, rather than clearing
    // the selection and silently dropping them (Codex P2 on PR #108).
    const batch = ids.slice(0, MAX_BULK_DRAFT);
    const rest = ids.slice(MAX_BULK_DRAFT);
    batch.forEach((id) => enqueue(id));
    setSelectedIds(new Set(rest));
    toast.success(
      rest.length > 0
        ? `Drafting ${batch.length} emails… ${rest.length} still selected (max ${MAX_BULK_DRAFT} at a time).`
        : `Drafting ${batch.length} email${batch.length === 1 ? "" : "s"}…`,
    );
  };

  const openComposer = (lead: QueueLeadRow) => {
    // Open the composer WITHOUT prefill so it generates (which hydrates reply
    // threading) — hitting the draft cache the bulk pre-draft warmed, so it's
    // fast. Passing the pre-generated text as prefill would make the dialog skip
    // its threading hydration and send replies unthreaded (Codex P1 on PR #108).
    consume(lead.id); // clear the "Draft ready" indicator now they're acting
    setComposerLead(lead);
    setComposerOpen(true);
  };

  const renderDraftTag = (lead: QueueLeadRow) => {
    const ds = getStatus(lead.id);
    if (ds?.status === "generating") return <span className="text-xs text-muted-foreground">Drafting…</span>;
    if (ds?.status === "ready")
      return <span className="text-xs font-medium text-blue-600 dark:text-blue-400">Draft ready</span>;
    return null;
  };

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

      {/* Selection bar (bulk draft) */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-blue-50 px-4 py-2 dark:bg-blue-950/40">
          <span className="text-sm font-medium text-blue-900 dark:text-blue-200">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleBulkDraft}>
              Draft emails
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

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
                <Checkbox checked={selectedIds.has(lead.id)} onCheckedChange={() => toggleSelect(lead.id)} />
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
                  <p className="truncate text-xs text-muted-foreground">
                    {whyNow(lead)}
                    {getStatus(lead.id) ? <span className="mx-1.5">·</span> : null}
                    {renderDraftTag(lead)}
                  </p>
                </div>
                {channel === "email" && (
                  <Button size="sm" className="shrink-0" onClick={() => openComposer(lead)}>
                    {ctaLabel(lead)}
                  </Button>
                )}
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

      {/* Reuse the existing email composer — opens with a draft warming up. */}
      {composerLead && (
        <EmailActionDialog
          lead={{
            id: composerLead.id,
            name: composerLead.name,
            company: composerLead.company ?? "",
            email: composerLead.email ?? "",
            stage: composerLead.stage ?? "",
            next_action_key: composerLead.next_action_key,
            next_action_label: composerLead.next_action_label,
            motion: composerLead.motion ?? undefined,
          }}
          open={composerOpen}
          actionKey={composerLead.next_action_key ?? undefined}
          onOpenChange={(o) => {
            setComposerOpen(o);
            if (!o) {
              setComposerLead(null);
              void loadTodos();
            }
          }}
        />
      )}
    </div>
  );
}
