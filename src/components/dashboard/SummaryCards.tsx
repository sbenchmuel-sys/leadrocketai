import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Handshake, Zap, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterType = "all" | "active" | "needs_action" | "meetings" | "stale" | "nurture_candidates";

interface ExecutiveCardsProps {
  needsAction: number;
  closing: number;
  automationRunning: number;
  momentum: number;
  isLoading: boolean;
}

const cardConfig = [
  {
    key: "needs_action",
    label: "Needs Action",
    icon: AlertCircle,
    gradient: "bg-gradient-to-br from-warning/10 to-warning/5",
    iconBg: "bg-warning/10",
    iconColor: "text-warning",
  },
  {
    key: "closing",
    label: "Deals in Closing",
    icon: Handshake,
    gradient: "bg-gradient-to-br from-success/10 to-success/5",
    iconBg: "bg-success/10",
    iconColor: "text-success",
  },
  {
    key: "automation",
    label: "Automation Running",
    icon: Zap,
    gradient: "bg-gradient-to-br from-info/10 to-info/5",
    iconBg: "bg-info/10",
    iconColor: "text-info",
  },
  {
    key: "momentum",
    label: "Momentum",
    icon: TrendingUp,
    gradient: "bg-gradient-to-br from-purple-500/10 to-purple-500/5",
    iconBg: "bg-purple-500/10",
    iconColor: "text-purple-500",
  },
];

function MomentumIndicator({ value }: { value: number }) {
  if (value > 0) {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-success">
        <TrendingUp className="h-3 w-3" /> +{value}
      </span>
    );
  }
  if (value < 0) {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-destructive">
        <TrendingDown className="h-3 w-3" /> {value}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <Minus className="h-3 w-3" /> 0
    </span>
  );
}

export function SummaryCards({
  needsAction,
  closing,
  automationRunning,
  momentum,
  isLoading,
}: ExecutiveCardsProps) {
  const values = [needsAction, closing, automationRunning, momentum];

  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
      {cardConfig.map((card, index) => {
        const isMomentum = card.key === "momentum";

        return (
          <Card
            key={card.key}
            className={cn(
              "transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 border-0",
              card.gradient,
              !isLoading && "animate-fade-in"
            )}
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    {card.label}
                  </p>
                  <div className="flex items-baseline gap-2">
                    {isMomentum ? (
                      isLoading ? (
                        <p className="text-3xl font-bold text-foreground">—</p>
                      ) : (
                        <MomentumIndicator value={values[index]} />
                      )
                    ) : (
                      <p
                        className={cn(
                          "text-3xl font-bold text-foreground tabular-nums",
                          !isLoading && "animate-count-up"
                        )}
                        style={{ animationDelay: `${index * 50 + 100}ms` }}
                      >
                        {isLoading ? "—" : values[index]}
                      </p>
                    )}
                  </div>
                </div>
                <div className={cn("p-2 rounded-lg", card.iconBg)}>
                  <card.icon className={cn("h-5 w-5", card.iconColor)} />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
