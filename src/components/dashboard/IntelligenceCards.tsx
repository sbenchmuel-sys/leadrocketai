import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, TrendingUp, TrendingDown, Percent, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { FilterType } from "./SummaryCards";

interface IntelligenceCardsProps {
  staleCount: number;
  momentum: number; // positive = net forward movement, negative = regression
  replyRate: number; // percentage 0-100
  onStaleClick?: () => void;
  activeFilter?: FilterType;
}

export function IntelligenceCards({ 
  staleCount, 
  momentum, 
  replyRate,
  onStaleClick,
  activeFilter,
}: IntelligenceCardsProps) {
  const getMomentumDisplay = () => {
    if (momentum === 0) {
      return { text: "No change", icon: Minus, color: "text-muted-foreground" };
    }
    if (momentum > 0) {
      return { text: `+${momentum} net moves`, icon: TrendingUp, color: "text-success" };
    }
    return { text: `${momentum} net moves`, icon: TrendingDown, color: "text-destructive" };
  };

  const momentumDisplay = getMomentumDisplay();
  const MomentumIcon = momentumDisplay.icon;

  return (
    <div className="grid gap-3 grid-cols-3">
      {/* Stale Leads */}
      <Card 
        className={cn(
          "cursor-pointer transition-all duration-200 hover:shadow-md border-warning/20",
          staleCount > 0 && "bg-warning/5",
          activeFilter === "stale" && "ring-2 ring-warning shadow-md"
        )}
        onClick={onStaleClick}
      >
        <CardContent className="p-3">
          <div className="flex items-center gap-2">
            <div className={cn(
              "p-1.5 rounded-md",
              staleCount > 0 ? "bg-warning/10" : "bg-muted"
            )}>
              <AlertTriangle className={cn(
                "h-4 w-4",
                staleCount > 0 ? "text-warning" : "text-muted-foreground"
              )} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Stale Leads
              </p>
              <div className="flex items-baseline gap-1.5">
                <span className={cn(
                  "text-lg font-bold tabular-nums",
                  staleCount > 0 ? "text-warning" : "text-foreground"
                )}>
                  {staleCount}
                </span>
                <span className="text-xs text-muted-foreground">
                  {staleCount === 1 ? "lead" : "leads"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                &gt; 14 days silent
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Momentum */}
      <Card className="transition-all duration-200 hover:shadow-md">
        <CardContent className="p-3">
          <div className="flex items-center gap-2">
            <div className={cn(
              "p-1.5 rounded-md",
              momentum > 0 ? "bg-success/10" : momentum < 0 ? "bg-destructive/10" : "bg-muted"
            )}>
              <MomentumIcon className={cn("h-4 w-4", momentumDisplay.color)} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Momentum
              </p>
              <div className="flex items-baseline gap-1.5">
                <span className={cn("text-lg font-bold tabular-nums", momentumDisplay.color)}>
                  {momentum > 0 ? `+${momentum}` : momentum === 0 ? "—" : momentum}
                </span>
                {momentum !== 0 && (
                  <span className="text-xs text-muted-foreground">net</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">
                last 7 days
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Reply Rate */}
      <Card className="transition-all duration-200 hover:shadow-md">
        <CardContent className="p-3">
          <div className="flex items-center gap-2">
            <div className={cn(
              "p-1.5 rounded-md",
              replyRate >= 30 ? "bg-success/10" : replyRate >= 15 ? "bg-warning/10" : "bg-muted"
            )}>
              <Percent className={cn(
                "h-4 w-4",
                replyRate >= 30 ? "text-success" : replyRate >= 15 ? "text-warning" : "text-muted-foreground"
              )} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Reply Rate
              </p>
              <div className="flex items-baseline gap-1.5">
                <span className={cn(
                  "text-lg font-bold tabular-nums",
                  replyRate >= 30 ? "text-success" : replyRate >= 15 ? "text-warning" : "text-foreground"
                )}>
                  {replyRate}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                last 30 days
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
