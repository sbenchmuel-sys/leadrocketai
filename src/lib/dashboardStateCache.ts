import type { RevenueState } from "@/lib/dashboardUtils";

interface DashboardState {
  revenueStateFilter: RevenueState;
  scrollY: number;
}

let cached: DashboardState = {
  revenueStateFilter: "action_required",
  scrollY: 0,
};

export const getDashboardState = () => cached;

export const setDashboardFilter = (filter: RevenueState) => {
  cached.revenueStateFilter = filter;
};

export const setDashboardScroll = (y: number) => {
  cached.scrollY = y;
};
