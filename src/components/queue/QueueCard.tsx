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

import { Link } from "react-router-dom";
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
  chipForLead,
  leadWasAway,
  queueButtonLabel,
  type QueueLeadRow,
  type QueueLatestInbound,
} from "@/lib/queueQueries";
import { useBackgroundDraftQueue } from "@/hooks/useBackgroundDraftQueue";
import ReEngagementCard from "@/components/lead/ReEngagementCard";
import { isReEngagementCandidate } from "@/lib/reEngagement";

export interface QueueCardProps {
  lead: QueueLeadRow;
  latestInbound: QueueLatestInbound | undefined;
  onMarkHandled: (lead: QueueLeadRow) => void;
  onSnooze: (lead: QueueLeadRow, days: 3 | 5 | 7) => void;
}

// Friendly category labels keyed off the chip bucket. Why-now line
// derives from these so chip-vs-card stays in lockstep (brief
// "chip-bucket mapping" note).
const CATEGORY_LABEL: Record<"replied" | "followup_due", string> = {
  replied: "Replied",
  followup_due: "Follow up",
};

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

function buildWhyNowLine(lead: QueueLeadRow, latestInbound: QueueLatestInbound | undefined): string {
  const bucket = chipForLead({
    next_action_key: lead.next_action_key,
    action_resurfaced_at: lead.action_resurfaced_at,
  });
  const category = bucket ? CATEGORY_LABEL[bucket] : (lead.next_action_label ?? "Action needed");

  // Back-from-away: the trigger is the return, not the last-outbound
  // age (which predates the absence and would read oddly). Show just
  // the category — the "was away — back now" note below carries the
  // context.
  if (leadWasAway({ next_action_key: lead.next_action_key })) {
    return category; // "Follow up"
  }

  // Pick the timestamp that matches the action type. Customer-waiting
  // → relative to last inbound. Rep-waiting → relative to last outbound.
  const ts = bucket === "replied" ? lead.last_inbound_at : lead.last_outbound_at;

  let timePhrase = "";
  if (ts) {
    try {
      const dt = new Date(ts);
      if (Number.isFinite(dt.getTime())) {
        const rel = formatDistanceToNow(dt, { addSuffix: false });
        // Outbound side uses "sent X ago" framing per the brief examples.
        timePhrase = bucket === "followup_due" ? `sent ${rel} ago` : `${rel} ago`;
      }
    } catch {
      timePhrase = "";
    }
  }

  // Intent annotation, only when meaningful AND when the row isn't a
  // deterministic-detector class (defensive — those should already be
  // hidden but a show-all rep could see them).
  let intentSuffix = "";
  const rawIntent = latestInbound?.intent ?? null;
  if (rawIntent && INTENT_DISPLAY[rawIntent]) {
    intentSuffix = ` — ${INTENT_DISPLAY[rawIntent]}`;
  }

  // Compose. Examples from the brief:
  //   "Replied 2h ago — pricing question"
  //   "Follow up — sent 6d ago"
  if (bucket === "followup_due") {
    return `${category}${timePhrase ? " — " + timePhrase : ""}${intentSuffix}`;
  }
  return `${category}${timePhrase ? " " + timePhrase : ""}${intentSuffix}`;
}

export function QueueCard({ lead, latestInbound, onMarkHandled, onSnooze }: QueueCardProps) {
  const whyNow = buildWhyNowLine(lead, latestInbound);
  // Only genuine out-of-office returns get the note — never plain
  // follow-ups (gated on the ooo_return_followup key via leadWasAway).
  const wasAway = leadWasAway({ next_action_key: lead.next_action_key });
  const aiSummary = (latestInbound?.ai_summary ?? "").trim();
  // When ai_summary contains bullets, render with SummaryBody (keeps bullet
  // structure). Otherwise fall back to cleanBodyText prose flow.
  const aiSummaryIsBulleted = aiSummary
    ? parseSummary(aiSummary).isBulleted
    : false;
  const proseBody = aiSummaryIsBulleted
    ? ""
    : cleanBodyText({
        ai_summary: latestInbound?.ai_summary ?? null,
        snippet_text: latestInbound?.snippet_text ?? null,
        subject: latestInbound?.subject ?? null,
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

        {wasAway && (
          <p className="mt-0.5 text-xs text-muted-foreground/80">was away — back now</p>
        )}

        {aiSummaryIsBulleted ? (
          <div className="mt-1.5">
            <SummaryBody
              text={aiSummary}
              maxBullets={3}
              textClassName="text-sm text-foreground/85 leading-relaxed"
            />
          </div>
        ) : (
          <p
            className={cn(
              "mt-1.5 text-sm",
              hasContent ? "text-foreground/85" : "text-muted-foreground/60 italic",
            )}
          >
            {proseBody || "[No preview available]"}
          </p>
        )}
      </Link>

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

        {/* Pre-generate draft — quiet helper button on the right */}
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
      </div>

      {/* Re-engagement prompt — only renders for warm/inbound leads whose last
          outbound is newer than their last inbound. Self-gated; UI-only. */}
      <div className="px-3 pb-3">
        <ReEngagementCard
          leadId={lead.id}
          gate={{
            motion: lead.motion,
            // QueueLeadRow doesn't carry source_type; the motion check alone is
            // a conservative subset of the resolver's inbound-context branch.
            source_type: null,
            last_outbound_at: lead.last_outbound_at,
            last_inbound_at: lead.last_inbound_at,
            next_action_key: lead.next_action_key,
            stage: lead.stage,
          }}
          compact
        />
      </div>
    </div>
  );
}
