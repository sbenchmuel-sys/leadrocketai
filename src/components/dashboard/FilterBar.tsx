import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DISPLAY_PHASE_ORDER, type DisplayPhase } from "@/lib/dashboardUtils";
import {
  type TabFilters,
  type ActivityFilter,
  type AutomationFilter,
  type NextActionGroup,
  EMPTY_FILTERS,
  hasActiveFilters,
} from "@/lib/dashboardStateCache";

const ACTIVITY_LABELS: Record<ActivityFilter, string> = {
  all: "Any time",
  recent_inbound: "Recent inbound (≤7d)",
  recent_outbound: "Recent outbound (≤7d)",
  stale: "Stale (>14d)",
  never: "Never contacted",
};

const ACTION_GROUP_LABELS: Record<NextActionGroup, string> = {
  reply: "Reply",
  follow_up: "Follow-up",
  recap: "Recap",
  nurture: "Nurture",
  closing: "Closing",
  none: "No action needed",
};

const ACTION_GROUPS: NextActionGroup[] = ["reply", "follow_up", "recap", "nurture", "closing", "none"];

const AUTOMATION_LABELS: Record<AutomationFilter, string> = {
  all: "All",
  on: "On",
  off: "Off",
};

interface FilterBarProps {
  filters: TabFilters;
  onChange: (next: TabFilters) => void;
}

export function FilterBar({ filters, onChange }: FilterBarProps) {
  const togglePhase = (p: DisplayPhase) => {
    const has = filters.phases.includes(p);
    onChange({ ...filters, phases: has ? filters.phases.filter((x) => x !== p) : [...filters.phases, p] });
  };
  const toggleAction = (a: NextActionGroup) => {
    const has = filters.nextActions.includes(a);
    onChange({ ...filters, nextActions: has ? filters.nextActions.filter((x) => x !== a) : [...filters.nextActions, a] });
  };

  const phaseLabel = filters.phases.length === 0 ? "Phase" : `Phase · ${filters.phases.length}`;
  const actionLabel = filters.nextActions.length === 0 ? "Next Action" : `Next Action · ${filters.nextActions.length}`;
  const activityLabel = filters.activity === "all" ? "Activity" : ACTIVITY_LABELS[filters.activity];
  const automationLabel = filters.automation === "all" ? "Automation" : `Automation · ${AUTOMATION_LABELS[filters.automation]}`;

  const active = hasActiveFilters(filters);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Phase */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={cn("h-8 text-xs", filters.phases.length > 0 && "border-primary/40 text-primary")}>
            {phaseLabel}
            <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuLabel className="text-xs">Filter by phase</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {DISPLAY_PHASE_ORDER.map((p) => (
            <DropdownMenuCheckboxItem
              key={p}
              checked={filters.phases.includes(p)}
              onCheckedChange={() => togglePhase(p)}
              onSelect={(e) => e.preventDefault()}
            >
              {p}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Activity */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={cn("h-8 text-xs", filters.activity !== "all" && "border-primary/40 text-primary")}>
            {activityLabel}
            <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-xs">Last activity</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={filters.activity}
            onValueChange={(v) => onChange({ ...filters, activity: v as ActivityFilter })}
          >
            {(Object.keys(ACTIVITY_LABELS) as ActivityFilter[]).map((k) => (
              <DropdownMenuRadioItem key={k} value={k}>
                {ACTIVITY_LABELS[k]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Next Action */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={cn("h-8 text-xs", filters.nextActions.length > 0 && "border-primary/40 text-primary")}>
            {actionLabel}
            <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuLabel className="text-xs">Next action type</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {ACTION_GROUPS.map((a) => (
            <DropdownMenuCheckboxItem
              key={a}
              checked={filters.nextActions.includes(a)}
              onCheckedChange={() => toggleAction(a)}
              onSelect={(e) => e.preventDefault()}
            >
              {ACTION_GROUP_LABELS[a]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Automation */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={cn("h-8 text-xs", filters.automation !== "all" && "border-primary/40 text-primary")}>
            {automationLabel}
            <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          <DropdownMenuLabel className="text-xs">Automation</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={filters.automation}
            onValueChange={(v) => onChange({ ...filters, automation: v as AutomationFilter })}
          >
            {(Object.keys(AUTOMATION_LABELS) as AutomationFilter[]).map((k) => (
              <DropdownMenuRadioItem key={k} value={k}>
                {AUTOMATION_LABELS[k]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {active && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs text-muted-foreground"
          onClick={() => onChange({ ...EMPTY_FILTERS })}
        >
          <X className="h-3 w-3 mr-1" /> Clear
        </Button>
      )}
    </div>
  );
}
