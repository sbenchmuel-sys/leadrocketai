import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Users, Flame, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterType = "all" | "active" | "needs_action" | "meetings" | "stale" | "nurture_candidates" | "warming_up" | "automation";

interface ExecutiveCardsProps {
  activeLeads: number;
  needsAction: number;
  warmingUp: number;
  automationRunning: number;
  isLoading: boolean;
  onCardClick?: (filter: FilterType) => void;
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
  onCardClick,
  activeFilter,
}: ExecutiveCardsProps) {
  const values = [activeLeads, needsAction, warmingUp, automationRunning];

  const keyToFilter: Record<string, FilterType> = {
    active: "active",
    needs_action: "needs_action",
    warming_up: "warming_up",
    automation: "automation",
  };

  return (
    <div className="grid gap-5 grid-cols-2 lg:grid-cols-4">
      {cardConfig.map((card, index) => {
        const filterKey = keyToFilter[card.key];
        const isActive = activeFilter === filterKey;

        return (
          <Card
            key={card.key}
            className={cn(
              "transition-all duration-300 border border-border rounded-2xl",
              "hover:shadow-lg hover:-translate-y-1",
              card.gradient,
              !isLoading && "animate-fade-in",
              card.emphasis === "strong" && !isActive && "ring-1 ring-warning/20",
              "cursor-pointer",
              isActive && "ring-2 ring-primary shadow-[0_0_24px_hsl(217_91%_60%/0.12)]",
            )}
            style={{ animationDelay: `${index * 60}ms` }}
            onClick={() => onCardClick?.(filterKey)}
          >
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {card.label}
                  </p>
                  <p
                    className={cn(
                      "text-3xl font-semibold text-foreground tabular-nums tracking-tight",
                      !isLoading && "animate-count-up"
                    )}
                    style={{ animationDelay: `${index * 60 + 100}ms` }}
                  >
                    {isLoading ? "—" : values[index]}
                  </p>
                  {card.key === "warming_up" && !isLoading && (
                    <p className="text-[10px] text-muted-foreground/70 leading-tight">
                      Engagement + buying signals
                    </p>
                  )}
                </div>
                <div className={cn("p-2.5 rounded-xl", card.iconBg)}>
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
