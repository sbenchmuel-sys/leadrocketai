import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Users, Flame, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterType = "all" | "active" | "needs_action" | "meetings" | "stale" | "nurture_candidates" | "warming_up";

interface ExecutiveCardsProps {
  activeLeads: number;
  needsAction: number;
  warmingUp: number;
  automationRunning: number;
  isLoading: boolean;
  onWarmingUpClick?: () => void;
  activeFilter?: FilterType;
}

const cardConfig = [
  {
    key: "active",
    label: "Active Leads",
    icon: Users,
    gradient: "bg-gradient-to-br from-muted/40 to-muted/20",
    iconBg: "bg-muted",
    iconColor: "text-muted-foreground",
    emphasis: "soft" as const,
  },
  {
    key: "needs_action",
    label: "Needs Action",
    icon: AlertCircle,
    gradient: "bg-gradient-to-br from-warning/15 to-warning/5",
    iconBg: "bg-warning/15",
    iconColor: "text-warning",
    emphasis: "strong" as const,
  },
  {
    key: "warming_up",
    label: "Warming Up",
    icon: Flame,
    gradient: "bg-gradient-to-br from-orange-500/10 to-orange-500/5",
    iconBg: "bg-orange-500/10",
    iconColor: "text-orange-500",
    emphasis: "medium" as const,
  },
  {
    key: "automation",
    label: "Automation Running",
    icon: Zap,
    gradient: "bg-gradient-to-br from-info/10 to-info/5",
    iconBg: "bg-info/10",
    iconColor: "text-info",
    emphasis: "neutral" as const,
  },
];

export function SummaryCards({
  activeLeads,
  needsAction,
  warmingUp,
  automationRunning,
  isLoading,
  onWarmingUpClick,
  activeFilter,
}: ExecutiveCardsProps) {
  const values = [activeLeads, needsAction, warmingUp, automationRunning];

  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
      {cardConfig.map((card, index) => {
        const isClickable = card.key === "warming_up";
        const isActive = card.key === "warming_up" && activeFilter === "warming_up";

        return (
          <Card
            key={card.key}
            className={cn(
              "transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 border-0",
              card.gradient,
              !isLoading && "animate-fade-in",
              card.emphasis === "strong" && "ring-1 ring-warning/30",
              isClickable && "cursor-pointer",
              isActive && "ring-2 ring-orange-500 shadow-md",
            )}
            style={{ animationDelay: `${index * 50}ms` }}
            onClick={isClickable ? onWarmingUpClick : undefined}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    {card.label}
                  </p>
                  <p
                    className={cn(
                      "text-3xl font-bold text-foreground tabular-nums",
                      !isLoading && "animate-count-up"
                    )}
                    style={{ animationDelay: `${index * 50 + 100}ms` }}
                  >
                    {isLoading ? "—" : values[index]}
                  </p>
                  {card.key === "warming_up" && !isLoading && (
                    <p className="text-[10px] text-muted-foreground leading-tight">
                      Engagement + buying signals
                    </p>
                  )}
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
