import type { RevenueState } from "@/lib/dashboardUtils";

export type ViewMode = "queue" | "table";

interface DashboardState {
  revenueStateFilter: RevenueState;
  scrollY: number;
  viewMode: ViewMode;
  filterTouched: boolean;
}

let cached: DashboardState = {
  revenueStateFilter: "active",
  scrollY: 0,
  viewMode: "queue",
  filterTouched: false,
};

export const getDashboardState = () => cached;

export const setDashboardFilter = (filter: RevenueState) => {
  cached.revenueStateFilter = filter;
  cached.filterTouched = true;
};

export const setDashboardScroll = (y: number) => {
  cached.scrollY = y;
};

export const setDashboardViewMode = (mode: ViewMode) => {
  cached.viewMode = mode;
};

