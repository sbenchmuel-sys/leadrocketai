import { Card, CardContent } from "@/components/ui/card";
import { Users, Target, AlertCircle, Calendar, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterType = "all" | "active" | "needs_action" | "meetings" | "stale";

interface SummaryCardsProps {
  total: number;
  active: number;
  needsAction: number;
  meetings: number;
  activeFilter: FilterType;
  onFilterChange: (filter: FilterType) => void;
  isLoading: boolean;
  trends?: {
    total?: number;
    active?: number;
    needsAction?: number;
    meetings?: number;
  };
}

const cardStyles = {
  all: {
    gradient: "bg-gradient-to-br from-info/10 to-info/5",
    iconBg: "bg-info/10",
    iconColor: "text-info",
    activeRing: "ring-info",
  },
  active: {
    gradient: "bg-gradient-to-br from-success/10 to-success/5",
    iconBg: "bg-success/10",
    iconColor: "text-success",
    activeRing: "ring-success",
  },
  needs_action: {
    gradient: "bg-gradient-to-br from-warning/10 to-warning/5",
    iconBg: "bg-warning/10",
    iconColor: "text-warning",
    activeRing: "ring-warning",
  },
  meetings: {
    gradient: "bg-gradient-to-br from-purple-500/10 to-purple-500/5",
    iconBg: "bg-purple-500/10",
    iconColor: "text-purple-500",
    activeRing: "ring-purple-500",
  },
};

export function SummaryCards({
  total,
  active,
  needsAction,
  meetings,
  activeFilter,
  onFilterChange,
  isLoading,
  trends,
}: SummaryCardsProps) {
  const cards = [
    {
      key: "all" as FilterType,
      label: "Total Leads",
      value: total,
      icon: Users,
      trend: trends?.total,
    },
    {
      key: "active" as FilterType,
      label: "Active Deals",
      value: active,
      icon: Target,
      trend: trends?.active,
    },
    {
      key: "needs_action" as FilterType,
      label: "Needs Action",
      value: needsAction,
      icon: AlertCircle,
      trend: trends?.needsAction,
    },
    {
      key: "meetings" as FilterType,
      label: "Meetings",
      value: meetings,
      icon: Calendar,
      trend: trends?.meetings,
    },
  ];

  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
      {cards.map((card, index) => {
        const styles = cardStyles[card.key];
        const isActive = activeFilter === card.key;
        
        return (
          <Card
            key={card.key}
            className={cn(
              "cursor-pointer transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 border-0",
              styles.gradient,
              isActive && `ring-2 ${styles.activeRing} shadow-lg`,
              !isLoading && "animate-fade-in"
            )}
            style={{ animationDelay: `${index * 50}ms` }}
            onClick={() => onFilterChange(card.key)}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    {card.label}
                  </p>
                  <div className="flex items-baseline gap-2">
                    <p 
                      className={cn(
                        "text-3xl font-bold text-foreground tabular-nums",
                        !isLoading && "animate-count-up"
                      )}
                      style={{ animationDelay: `${index * 50 + 100}ms` }}
                    >
                      {isLoading ? "—" : card.value}
                    </p>
                    {card.trend !== undefined && card.trend !== 0 && !isLoading && (
                      <span
                        className={cn(
                          "flex items-center gap-0.5 text-xs font-medium",
                          card.trend > 0 ? "text-success" : "text-destructive"
                        )}
                      >
                        {card.trend > 0 ? (
                          <TrendingUp className="h-3 w-3" />
                        ) : (
                          <TrendingDown className="h-3 w-3" />
                        )}
                        {card.trend > 0 ? "+" : ""}{card.trend}
                      </span>
                    )}
                  </div>
                </div>
                <div className={cn("p-2 rounded-lg", styles.iconBg)}>
                  <card.icon className={cn("h-5 w-5", styles.iconColor)} />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
