import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CallSession } from "@/lib/callTypes";

interface CallTimelineCardProps {
  session: CallSession;
  outcomeLabel?: string;
  pipelineStatus?: "analyzed" | "transcribing" | "recording" | "failed" | "skipped";
}

function getStatusConfig(status: string) {
  switch (status) {
    case "completed":
      return { label: "Completed", className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" };
    case "no-answer":
      return { label: "No Answer", className: "bg-warning/10 text-warning border-warning/20" };
    case "busy":
      return { label: "Busy", className: "bg-warning/10 text-warning border-warning/20" };
    case "failed":
      return { label: "Failed", className: "bg-destructive/10 text-destructive border-destructive/20" };
    case "canceled":
      return { label: "Canceled", className: "bg-muted text-muted-foreground border-border" };
    default:
      return { label: status, className: "bg-muted text-muted-foreground border-border" };
  }
}

function getPipelineBadge(status?: string) {
  switch (status) {
    case "analyzed":
      return { label: "Analyzed", className: "bg-primary/10 text-primary border-primary/20" };
    case "transcribing":
      return { label: "Transcribing", className: "bg-info/10 text-info border-info/20" };
    case "recording":
      return { label: "Recording", className: "bg-warning/10 text-warning border-warning/20" };
    case "failed":
      return { label: "Failed", className: "bg-destructive/10 text-destructive border-destructive/20" };
    case "skipped":
      return { label: "Skipped (short)", className: "bg-muted text-muted-foreground border-border" };
    default:
      return null;
  }
}

function formatDuration(sec: number | null): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function CallTimelineCard({ session, outcomeLabel, pipelineStatus }: CallTimelineCardProps) {
  const navigate = useNavigate();
  const statusConfig = getStatusConfig(session.status);
  const pipelineBadge = getPipelineBadge(pipelineStatus);
  const DirectionIcon = session.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;

  return (
    <button
      onClick={() => navigate(`/app/calls/${session.id}`)}
      className="w-full text-left py-3 hover:bg-accent/30 rounded-lg px-3 -mx-3 transition-colors duration-150 group"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border text-amber-600 bg-amber-500/10 border-amber-500/20">
              <DirectionIcon className="h-3 w-3" />
              {session.direction === "inbound" ? "Inbound Call" : "Outbound Call"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {session.started_at
                ? format(new Date(session.started_at), "MMM d · h:mm a")
                : format(new Date(session.created_at), "MMM d · h:mm a")}
            </span>
            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", statusConfig.className)}>
              {statusConfig.label}
            </Badge>
            {pipelineBadge && (
              <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", pipelineBadge.className)}>
                {pipelineBadge.label}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
            <span>{session.from_number} → {session.to_number}</span>
            {session.duration_sec != null && (
              <span className="text-xs">{formatDuration(session.duration_sec)}</span>
            )}
          </div>
          {outcomeLabel && outcomeLabel !== "no_outcome" && (
            <p className="text-[12px] font-medium text-foreground/80">
              Outcome: <span className="capitalize">{outcomeLabel}</span>
            </p>
          )}
        </div>
        <Phone className="h-4 w-4 text-muted-foreground/50 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </button>
  );
}
