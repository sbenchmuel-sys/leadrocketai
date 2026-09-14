// ============================================================
// QueueCard — single lead card on the /app/queue page.
//
// Layout (brief §6):
//   1. Lead name · Company name        (company in muted color)
//   2. Why-now line                    (category + time + optional intent)
//   3. Clean body                      (ai_summary, snippet_text fallback)
//   4. [Reply / Follow up] [Mark handled] [Snooze ▾]
//
// Tap-through: clicking name/company/why-now/body routes to Lead
// Detail. The action buttons stop propagation so the rep can mark/
// snooze without leaving the queue.
//
// All mutations are optimistic: the parent (Queue.tsx) removes the
// card immediately and shows an undo toast. If the RPC fails, the
// parent restores the card and surfaces the error.
//
// Mobile (brief §11): buttons wrap, name/body truncate at narrow
// widths. Tested visually at 375px (iPhone SE).
// ============================================================

import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { fetchLatestMessageBody } from "@/lib/queueQueries";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Mail, FileText, MoreVertical, Wand2, Check, Loader2 } from "lucide-react";
import { SummaryBody, parseSummary } from "@/components/SummaryBody";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { cleanBodyText } from "@/lib/cleanBodyText";
import {
  anchorTimestamp,
  describeOutboundCall,
  describeQueueSituation,
  isOutboundCall,
  previewMatchesAnchor,
  queueButtonLabel,
  type QueueLeadRow,
  type QueueLatestInbound,
  type QueueLatestMessage,
  type QueueSituation,
} from "@/lib/queueQueries";
import { useBackgroundDraftQueue } from "@/hooks/useBackgroundDraftQueue";
import ReEngagementCard from "@/components/lead/ReEngagementCard";
import { isReEngagementCandidate } from "@/lib/reEngagement";

export interface QueueCardProps {
  lead: QueueLeadRow;
  latestInbound: QueueLatestInbound | undefined;
  /** The rep's own latest message — what a follow-up card is about. */
  latestOutbound: QueueLatestMessage | undefined;
  /** The meeting a recap card is about. Undefined → the card shows no preview. */
  latestMeeting?: QueueLatestMessage | undefined;
  onMarkHandled: (lead: QueueLeadRow) => void;
  onSnooze: (lead: QueueLeadRow, days: 3 | 5 | 7) => void;
}

// Intents we DISPLAY as why-now context. Deterministic-detector
// intents (calendar_accept, ooo_reply, bounce, zoom_recap,
// meeting_confirmation, unsubscribe) are excluded — those would
// already be hidden by the intent-hide rule, so seeing one here means
// the rep flipped show-all on; do not annotate, to avoid pretending
// it's a real signal.
const INTENT_DISPLAY: Record<string, string> = {
  book_meeting: "wants to book",
  pricing: "pricing question",
  technical_sdk: "technical question",
  security_privacy: "security/privacy",
  legal_procurement: "legal/procurement",
  partnership: "partnership ask",
  support: "support question",
  human_reply: "", // generic — show no annotation
  defer_request: "asked to defer",
  not_sure: "",
  unknown: "",
};

/**
 * The why-now line: what happened, when, and (when it's their message) what it
 * was about. The "what happened" half comes from `describeQueueSituation` —
 * a pure table in queueQueries — so a dozen different follow-up keys no longer
 * collapse into the single word "Follow up".
 *
 * Exported for the label test: it composes the clauses, the table supplies them.
 */
export function buildWhyNowLine(
  lead: QueueLeadRow,
  situation: QueueSituation,
  /** The message (or call) the card is about — the one `situation.bodySource` names. */
  message: QueueLatestMessage | undefined,
): string {
  // The timestamp is the clock that SCHEDULED the card (see QueueAnchorField) —
  // their reply, my unanswered message, or the nurture send specifically. Using
  // `last_outbound_at` for a nurture card dated it off whatever the rep had done
  // most recently, which is not what the cadence measured.
  const ts = anchorTimestamp(lead, situation);

  let timePhrase = "";
  if (situation.showTime && ts) {
    try {
      const dt = new Date(ts);
      if (Number.isFinite(dt.getTime())) {
        const rel = formatDistanceToNow(dt, { addSuffix: false });
        timePhrase = situation.bodySource !== "outbound"
          ? `${rel} ago`
          // Nothing was "sent" when the rep picked up the phone.
          : isOutboundCall(message) ? `called ${rel} ago` : `sent ${rel} ago`;
      }
    } catch {
      timePhrase = "";
    }
  }

  // Intent annotation belongs to THEIR message, so it only rides along on an
  // inbound card. Deterministic-detector classes (bounce, OOO, calendar accept)
  // carry no display string — those rows are normally intent-hidden anyway, and
  // annotating one would dress noise up as a signal.
  const rawIntent = situation.bodySource === "inbound" ? message?.intent ?? null : null;
  const intentSuffix = rawIntent && INTENT_DISPLAY[rawIntent] ? ` — ${INTENT_DISPLAY[rawIntent]}` : "";

  // Examples:
  //   "They replied 2 hours ago — pricing question"
  //   "No reply to your last email · sent 6 days ago"
  //   "Not sent — you're over your sending limit · auto-send paused until Sep 12"
  const clauses = [situation.label, situation.detail, timePhrase].filter(
    (c): c is string => !!c && c.length > 0,
  );
  return clauses.join(" · ") + intentSuffix;
}

export function QueueCard({
  lead, latestInbound, latestOutbound, latestMeeting, onMarkHandled, onSnooze,
}: QueueCardProps) {
  // Computed BEFORE the situation because the situation depends on it: a
  // follow-up triggered by a call is a different sentence from one triggered by
  // an email, and the card must not describe a call as a message.
  const latestOutboundIsCall = isOutboundCall(latestOutbound);
  const situation = describeQueueSituation(
    { next_action_key: lead.next_action_key, next_action_label: lead.next_action_label },
    { latestOutboundIsCall },
  );
  // The thing this card is ACTUALLY about: their reply, my unanswered message,
  // or — for a recap — the meeting itself.
  const showingMine = situation.bodySource === "outbound";
  const showingMeeting = situation.bodySource === "meeting";
  const candidate = showingMeeting
    ? latestMeeting
    : showingMine
      ? latestOutbound
      : latestInbound;
  // Quote it ONLY if it is the event that scheduled this card. Where the
  // correlation can't be established — a nurture send that has scrolled out of
  // the window, an unidentifiable meeting — the card carries no body rather
  // than a plausible-looking neighbour.
  const message = previewMatchesAnchor(lead, situation, candidate) ? candidate : undefined;
  const whyNow = buildWhyNowLine(lead, situation, message);
  // A call has no text to quote. Rather than reaching past it for an older
  // email — which is what this card used to do, under a caption claiming the
  // email was the thing — it is rendered as the call it is.
  const showingCall = showingMine && latestOutboundIsCall;
  const aiSummary = showingCall ? "" : (message?.ai_summary ?? "").trim();
  // When ai_summary contains bullets, render with SummaryBody (keeps bullet
  // structure). Otherwise fall back to cleanBodyText prose flow.
  const aiSummaryIsBulleted = aiSummary
    ? parseSummary(aiSummary).isBulleted
    : false;
  const proseBody = aiSummaryIsBulleted
    ? ""
    : showingCall
      ? describeOutboundCall(latestOutbound)
      : cleanBodyText({
          ai_summary: message?.ai_summary ?? null,
          snippet_text: message?.snippet_text ?? null,
          subject: message?.subject ?? null,
        });
  const hasContent = aiSummaryIsBulleted || !!proseBody;

  const buttonLabel = queueButtonLabel({
    next_action_key: lead.next_action_key,
    action_resurfaced_at: lead.action_resurfaced_at,
  });
  const ButtonIcon = buttonLabel === "Reply" ? Mail : FileText;

  // Re-engagement eligibility — when shown, suppress the generic
  // pre-generate "Draft" wand button so the rep sees a single draft
  // action on the card.
  const reEngagementGate = {
    motion: lead.motion,
    source_type: null,
    last_outbound_at: lead.last_outbound_at,
    last_inbound_at: lead.last_inbound_at,
    next_action_key: lead.next_action_key,
    stage: lead.stage,
  };
  const showReEngagement = isReEngagementCandidate(reEngagementGate);

  // Reuse the pre-generate draft queue from PriorityActions so the
  // rep gets a warm draft when they actually click into Lead Detail.
  // Per CLAUDE.md / brief hard constraints.
  const { enqueue, getStatus } = useBackgroundDraftQueue();
  const draftStatus = getStatus(lead.id);

  const handlePreGenerate: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (draftStatus?.status === "generating") return;
    void enqueue(lead.id);
  };

  // Full message, fetched on demand (see fetchLatestMessageBody) — the same
  // direction the card body quotes, so "Show full email" opens the email the
  // card is about rather than the other side of the thread.
  const [fullBody, setFullBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  const handleToggleFullBody = async () => {
    if (fullBody) {
      setFullBody(null);
      return;
    }
    setLoadingBody(true);
    try {
      // Inbound only — the button is rendered only on inbound cards (outbound
      // bodies purge at 72h), so the default direction is the right one.
      const body = await fetchLatestMessageBody(lead.id);
      if (!body) {
        toast.info("The full text of this email is no longer stored — showing the summary.");
      } else {
        setFullBody(body);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load the full email");
    } finally {
      setLoadingBody(false);
    }
  };


  return (
    <div className="rounded-lg border border-border bg-card transition-colors hover:bg-card/80">
      {/* Tap-through region — name, why-now, body */}
      <Link
        to={`/app/leads/${lead.id}`}
        state={{ originContext: "queue" }}
        className="block px-4 pt-3 pb-2"
      >
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-foreground truncate">{lead.name}</h3>
          {lead.company && (
            <span className="text-xs text-muted-foreground truncate">· {lead.company}</span>
          )}
        </div>

        <p className="mt-0.5 text-xs text-muted-foreground">{whyNow}</p>

        {/* Whose words are quoted below. Without this the rep has no way to
            tell the customer's reply from their own unanswered email. */}
        {!!message && !(showingMeeting && !hasContent) && (
          <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {showingCall
              ? "Your call"
              : showingMeeting
                ? "The meeting"
                : showingMine
                  ? "Your message"
                  : "Their message"}
          </p>
        )}

        {aiSummaryIsBulleted ? (
          <div className="mt-1.5">
            <SummaryBody
              text={aiSummary}
              maxBullets={3}
              textClassName="text-sm text-foreground/85 leading-relaxed"
            />
          </div>
        ) : showingMeeting && !hasContent ? (
          // No Zoom-matched meeting row (or its summary has purged). Showing
          // nothing beats reaching past the meeting for an unrelated email —
          // which is exactly what this card used to do.
          null
        ) : (
          <p
            className={cn(
              "mt-0.5 text-sm",
              hasContent ? "text-foreground/85" : "text-muted-foreground/60 italic",
            )}
          >
            {proseBody || "[No preview available]"}
          </p>
        )}
      </Link>

      {/* Full message — the card body is a summary/500-char snippet, so reps can
          pull the whole thing in place before replying.

          INBOUND ONLY, deliberately. `interactions.body_text` purges
          unconditionally at occurred_at + 72h for outbound rows (the inbound
          classifier gate does not apply — migration
          20260523000000_purge_gate_classified.sql), and a follow-up card is by
          definition about a message older than the 3/5-day wait. The button
          would toast "no longer stored" every single time. The subject/snippet
          fallback in the body above is what survives, and it stays. */}
      {situation.bodySource === "inbound" && !!message && (
        <div className="px-4 pb-2">
          {fullBody && (
            <p className="mb-1.5 whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-sm text-foreground/85">
              {fullBody}
            </p>
          )}
          <button
            type="button"
            onClick={handleToggleFullBody}
            disabled={loadingBody}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
          >
            {loadingBody
              ? "Loading…"
              : fullBody
                ? "Hide full email"
                : "Show full email"}
          </button>
        </div>
      )}


      {/* Action row — own button hit areas, not part of the tap-through */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2">
        <Button
          asChild
          size="sm"
          className="h-8 text-xs"
        >
          <Link to={`/app/leads/${lead.id}`} state={{ originContext: "queue" }}>
            <ButtonIcon className="mr-1 h-3 w-3" />
            {buttonLabel}
          </Link>
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMarkHandled(lead);
          }}
        >
          <Check className="mr-1 h-3 w-3" />
          Mark as handled
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={(e) => e.stopPropagation()}
            >
              Snooze
              <MoreVertical className="ml-1 h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onSnooze(lead, 3)}>Snooze 3 days</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSnooze(lead, 5)}>Snooze 5 days</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSnooze(lead, 7)}>Snooze 7 days</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Pre-generate draft — quiet helper button on the right.
            Hidden when re-engagement is eligible so the rep sees a single
            draft action on the card. */}
        {!showReEngagement && (
          <div className="ml-auto">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={cn(
                "h-7 w-7",
                draftStatus?.status === "ready" && "text-success",
              )}
              onClick={handlePreGenerate}
              disabled={draftStatus?.status === "generating"}
              title={
                draftStatus?.status === "generating"
                  ? "Generating draft…"
                  : draftStatus?.status === "ready"
                    ? "Draft ready — open in Lead Detail"
                    : "Pre-generate draft"
              }
            >
              {draftStatus?.status === "generating" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : draftStatus?.status === "ready" ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Re-engagement prompt — only renders for warm/inbound leads whose last
          outbound is newer than their last inbound. Self-gated; UI-only. */}
      {showReEngagement && (
        <div className="px-3 pb-3">
          <ReEngagementCard
            lead={{
              id: lead.id,
              name: lead.name,
              company: lead.company,
              email: lead.email,
              stage: lead.stage,
              motion: lead.motion,
              next_action_key: lead.next_action_key,
              next_action_label: lead.next_action_label,
            }}
            gate={reEngagementGate}
            compact
          />
        </div>
      )}
    </div>
  );
}
