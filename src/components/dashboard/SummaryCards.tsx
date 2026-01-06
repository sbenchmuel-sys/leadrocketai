import { Card, CardContent } from "@/components/ui/card";
import { Users, Target, AlertCircle, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterType = "all" | "active" | "needs_action" | "meetings";

interface SummaryCardsProps {
  total: number;
  active: number;
  needsAction: number;
  meetings: number;
  activeFilter: FilterType;
  onFilterChange: (filter: FilterType) => void;
  isLoading: boolean;
}

export function SummaryCards({
  total,
  active,
  needsAction,
  meetings,
  activeFilter,
  onFilterChange,
  isLoading,
}: SummaryCardsProps) {
  const cards = [
    {
      key: "all" as FilterType,
      label: "Total Leads",
      value: total,
      icon: Users,
    },
    {
      key: "active" as FilterType,
      label: "Active Deals",
      value: active,
      icon: Target,
    },
    {
      key: "needs_action" as FilterType,
      label: "Needs Action",
      value: needsAction,
      icon: AlertCircle,
    },
    {
      key: "meetings" as FilterType,
      label: "Meetings",
      value: meetings,
      icon: Calendar,
    },
  ];

  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card
          key={card.key}
          className={cn(
            "cursor-pointer transition-all hover:shadow-md",
            activeFilter === card.key && "ring-2 ring-primary"
          )}
          onClick={() => onFilterChange(card.key)}
        >
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{card.label}</p>
                <p className="text-2xl font-bold text-foreground">
                  {isLoading ? "..." : card.value}
                </p>
              </div>
              <card.icon className="h-8 w-8 text-muted-foreground/50" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
