import type { RevenueState } from "@/lib/dashboardUtils";

export type ViewMode = "queue" | "table";

interface DashboardState {
  revenueStateFilter: RevenueState;
  scrollY: number;
  viewMode: ViewMode;
}

let cached: DashboardState = {
  revenueStateFilter: "active",
  scrollY: 0,
  viewMode: "queue",
};

export const getDashboardState = () => cached;

export const setDashboardFilter = (filter: RevenueState) => {
  cached.revenueStateFilter = filter;
};

export const setDashboardScroll = (y: number) => {
  cached.scrollY = y;
};

export const setDashboardViewMode = (mode: ViewMode) => {
  cached.viewMode = mode;
};

