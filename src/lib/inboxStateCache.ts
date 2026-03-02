import type { CanonicalChannel } from "@/lib/channels";

// ── Types ──────────────────────────────────────────────────────────────

export type QuickChip = "needs_action" | "new_inbound" | "unreplied" | "hot" | "overdue" | null;
export type WaitingOn = "me" | "lead" | "automation" | null;
export type InboxSort = "urgent" | "recent" | "new_inbound" | "stale";

export interface SavedView {
  id: string;
  name: string;
  stateSnapshot: Omit<InboxState, "savedViews">;
}

export interface InboxState {
  searchQuery: string;
  quickChip: QuickChip;
  channelFilter: CanonicalChannel[];
  revenueState: string | null;
  waitingOn: WaitingOn;
  sortBy: InboxSort;
  savedViews: SavedView[];
}

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_STATE: InboxState = {
  searchQuery: "",
  quickChip: null,
  channelFilter: [],
  revenueState: null,
  waitingOn: null,
  sortBy: "recent",
  savedViews: [
    { id: "sv-hot", name: "Hot", stateSnapshot: { searchQuery: "", quickChip: "hot", channelFilter: [], revenueState: null, waitingOn: null, sortBy: "urgent" } },
    { id: "sv-unreplied", name: "Unreplied", stateSnapshot: { searchQuery: "", quickChip: "unreplied", channelFilter: [], revenueState: null, waitingOn: null, sortBy: "recent" } },
    { id: "sv-needs-action", name: "Needs Action", stateSnapshot: { searchQuery: "", quickChip: "needs_action", channelFilter: [], revenueState: null, waitingOn: null, sortBy: "urgent" } },
  ],
};

const STORAGE_KEY = "inbox_state_v1";

// ── Persistence ────────────────────────────────────────────────────────

function loadFromStorage(): InboxState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveToStorage(state: InboxState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota exceeded — ignore */
  }
}

// ── Singleton cache ────────────────────────────────────────────────────

let cached: InboxState = loadFromStorage();

export function getInboxState(): InboxState {
  return cached;
}

export function setInboxSearch(q: string) {
  cached = { ...cached, searchQuery: q };
  saveToStorage(cached);
}

export function setInboxQuickChip(chip: QuickChip) {
  cached = { ...cached, quickChip: chip };
  saveToStorage(cached);
}

export function setInboxChannelFilter(channels: CanonicalChannel[]) {
  cached = { ...cached, channelFilter: channels };
  saveToStorage(cached);
}

export function setInboxRevenueState(rs: string | null) {
  cached = { ...cached, revenueState: rs };
  saveToStorage(cached);
}

export function setInboxWaitingOn(w: WaitingOn) {
  cached = { ...cached, waitingOn: w };
  saveToStorage(cached);
}

export function setInboxSort(s: InboxSort) {
  cached = { ...cached, sortBy: s };
  saveToStorage(cached);
}

export function applyInboxSnapshot(snapshot: Omit<InboxState, "savedViews">) {
  cached = { ...cached, ...snapshot };
  saveToStorage(cached);
}

export function addSavedView(name: string) {
  const { savedViews, ...snapshot } = cached;
  const id = `sv-${Date.now()}`;
  cached = { ...cached, savedViews: [...savedViews, { id, name, stateSnapshot: snapshot }] };
  saveToStorage(cached);
}

export function removeSavedView(id: string) {
  cached = { ...cached, savedViews: cached.savedViews.filter((v) => v.id !== id) };
  saveToStorage(cached);
}

export function clearInboxFilters() {
  cached = { ...cached, searchQuery: "", quickChip: null, channelFilter: [], revenueState: null, waitingOn: null, sortBy: "recent" };
  saveToStorage(cached);
}

export function hasActiveFilters(state: InboxState): boolean {
  return !!(state.searchQuery || state.quickChip || state.channelFilter.length || state.revenueState || state.waitingOn || state.sortBy !== "recent");
}
