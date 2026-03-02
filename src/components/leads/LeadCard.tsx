import { formatDistanceToNow } from "date-fns";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnrichedLead, DealStage, Motion } from "@/lib/dashboardUtils";
import { STAGE_LABELS, MOTION_LABELS } from "@/lib/dashboardUtils";
import { routeLeadAction, primaryButtonLabel } from "@/lib/actionRouter";

// ── Props ──────────────────────────────────────────────────────────────

interface LeadCardProps {
  lead: EnrichedLead;
  primaryAction?: { label: string; onClick: () => void };
  secondaryActions?: Array<{ label: string; onClick: () => void }>;
  context?: "dashboard" | "list" | "inbox";
}

// ── Stage pill colour mapping (semantic tokens) ────────────────────────

const STAGE_VARIANT: Record<DealStage, string> = {
  new: "bg-muted text-muted-foreground",
  contacted: "bg-accent text-accent-foreground",
  engaged: "bg-primary/10 text-primary",
  post_meeting: "bg-primary/20 text-primary",
  closing: "bg-primary/30 text-primary",
  closed_won: "bg-primary text-primary-foreground",
  closed_lost: "bg-destructive/10 text-destructive",
};

// ── Component ──────────────────────────────────────────────────────────

export function LeadCard({ lead, primaryAction, secondaryActions, context = "list" }: LeadCardProps) {
  const stageLabel = STAGE_LABELS[lead.stage] ?? lead.stage;
  const motionLabel = MOTION_LABELS[lead.motion as Motion] ?? lead.motion;
  const routed = routeLeadAction(lead);
  const actionLine = lead.next_action_label || routed.label;

  const lastActivity = lead.last_activity_at
    ? formatDistanceToNow(new Date(lead.last_activity_at), { addSuffix: true })
    : null;

  const isCompact = context === "dashboard" || context === "inbox";

  return (
    <Card
      className={cn(
        "group relative border border-border bg-card transition-shadow hover:shadow-md",
        isCompact ? "px-3 py-2.5" : "px-4 py-3"
      )}
    >
      {/* Row 1: Name + company + stage pill */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className={cn("font-medium text-foreground truncate block", isCompact ? "text-sm" : "text-sm")}>
            {lead.name}
          </span>
          {lead.company && (
            <span className="text-xs text-muted-foreground truncate block">{lead.company}</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Badge
            variant="secondary"
            className={cn("text-[10px] px-1.5 py-0 h-4 font-medium border-0", STAGE_VARIANT[lead.stage])}
          >
            {stageLabel}
          </Badge>

          {secondaryActions && secondaryActions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[120px]">
                {secondaryActions.map((a) => (
                  <DropdownMenuItem key={a.label} onClick={a.onClick} className="text-xs">
                    {a.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Row 2: Next action */}
      <p className="text-xs text-muted-foreground mt-1.5 truncate">
        <span className="text-foreground/70 font-medium">Next:</span>{" "}
        {actionLine}
      </p>

      {/* Row 3: Meta + primary action */}
      <div className="flex items-center justify-between gap-2 mt-2">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground min-w-0">
          {lastActivity && <span className="truncate">{lastActivity}</span>}
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
            {motionLabel}
          </Badge>
        </div>

        {primaryAction && (
          <Button
            size="sm"
            variant="secondary"
            className="h-6 text-[11px] px-2.5 shrink-0"
            onClick={primaryAction.onClick}
          >
            {primaryAction.label || primaryButtonLabel(routed.priority)}
          </Button>
        )}
      </div>
    </Card>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────

export function LeadCardSkeleton() {
  return (
    <Card className="px-4 py-3 space-y-2.5">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5 flex-1">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-4 w-16 rounded-full" />
      </div>
      <Skeleton className="h-3 w-48" />
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-16 rounded" />
      </div>
    </Card>
  );
}
