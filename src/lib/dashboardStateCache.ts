import type { RevenueState, DisplayPhase } from "@/lib/dashboardUtils";

export type ViewMode = "queue" | "table";

export type ActivityFilter = "all" | "recent_inbound" | "recent_outbound" | "stale" | "never";
export type AutomationFilter = "all" | "on" | "off";
export type NextActionGroup = "reply" | "follow_up" | "recap" | "nurture" | "closing" | "none";

export interface TabFilters {
  phases: DisplayPhase[]; // multi-select; empty = all
  activity: ActivityFilter;
  nextActions: NextActionGroup[]; // multi-select; empty = all
  automation: AutomationFilter;
}

export const EMPTY_FILTERS: TabFilters = {
  phases: [],
  activity: "all",
  nextActions: [],
  automation: "all",
};

const FILTERABLE_TABS: RevenueState[] = ["active", "long_cycle", "automation"];

interface DashboardState {
  revenueStateFilter: RevenueState;
  scrollY: number;
  viewMode: Record<RevenueState, ViewMode>;
  filterTouched: boolean;
  filtersByTab: Partial<Record<RevenueState, TabFilters>>;
}

const STORAGE_KEY = "dashboard_state_v2";

const DEFAULT_VIEW_MODE: Record<RevenueState, ViewMode> = {
  active: "table",
  action_required: "queue",
  heating_up: "queue",
  long_cycle: "table",
  automation: "table",
};

function loadFromStorage(): DashboardState {
  const base: DashboardState = {
    revenueStateFilter: "active",
    scrollY: 0,
    viewMode: { ...DEFAULT_VIEW_MODE },
    filterTouched: false,
    filtersByTab: {},
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    return {
      ...base,
      viewMode: { ...DEFAULT_VIEW_MODE, ...(parsed.viewMode || {}) },
      filtersByTab: parsed.filtersByTab || {},
    };
  } catch {
    return base;
  }
}

let cached: DashboardState = loadFromStorage();

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ viewMode: cached.viewMode, filtersByTab: cached.filtersByTab }),
    );
  } catch { /* ignore quota */ }
}

export const getDashboardState = () => cached;

export const setDashboardFilter = (filter: RevenueState) => {
  cached.revenueStateFilter = filter;
  cached.filterTouched = true;
};

export const setDashboardScroll = (y: number) => {
  cached.scrollY = y;
};

export const setDashboardViewMode = (tab: RevenueState, mode: ViewMode) => {
  cached.viewMode = { ...cached.viewMode, [tab]: mode };
  persist();
};

export const getViewModeForTab = (tab: RevenueState): ViewMode => cached.viewMode[tab] ?? DEFAULT_VIEW_MODE[tab];

export const isFilterableTab = (tab: RevenueState): boolean => FILTERABLE_TABS.includes(tab);

export const getTabFilters = (tab: RevenueState): TabFilters =>
  cached.filtersByTab[tab] ?? { ...EMPTY_FILTERS };

export const setTabFilters = (tab: RevenueState, filters: TabFilters) => {
  cached.filtersByTab = { ...cached.filtersByTab, [tab]: filters };
  persist();
};

export const clearTabFilters = (tab: RevenueState) => {
  const next = { ...cached.filtersByTab };
  delete next[tab];
  cached.filtersByTab = next;
  persist();
};

export const hasActiveFilters = (f: TabFilters): boolean =>
  f.phases.length > 0 || f.activity !== "all" || f.nextActions.length > 0 || f.automation !== "all";
