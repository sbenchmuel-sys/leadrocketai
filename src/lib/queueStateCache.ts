// ============================================================
// queueStateCache — persist Queue page filter + pagination
// across navigation, mirroring `inboxStateCache.ts`.
//
// Persisted (localStorage):
//   - chip filter ("replied" | "followup_due" | null)
//   - current page index (0-based)
//
// Deliberately NOT persisted (per PR D spec §9):
//   - show-all toggle  → resets to false on every page load so a rep
//                        always starts the day with the curated queue.
//   - snapshot itself  → snapshots live in component state; persisting
//                        would defeat the "stable list" guarantee.
//   - scroll position  → out of scope for PR D.
//
// Shape is intentionally aligned with `inboxStateCache.ts` so Phase 2b's
// Lead List can adopt the same pattern (the brief explicitly notes
// "designed for reuse"). Keep the public API additive — do not rename
// existing exports without coordinating with Lead List.
// ============================================================

export type QueueChip = "replied" | "followup_due" | null;

export interface QueueState {
  chip: QueueChip;
  pageIndex: number;
}

const DEFAULT_STATE: QueueState = {
  chip: null,
  pageIndex: 0,
};

const STORAGE_KEY = "queue_state_v1";

function loadFromStorage(): QueueState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw) as Partial<QueueState>;
    // Defensive: only accept known chip values; reset page if negative.
    // A legacy persisted "ooo_back" falls through to null (no filter) —
    // that group no longer exists; back-from-away leads live in
    // "followup_due" now.
    const chip: QueueChip =
      parsed.chip === "replied" || parsed.chip === "followup_due"
        ? parsed.chip
        : null;
    const pageIndex =
      typeof parsed.pageIndex === "number" && parsed.pageIndex >= 0
        ? Math.floor(parsed.pageIndex)
        : 0;
    return { chip, pageIndex };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveToStorage(state: QueueState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota exceeded / private-mode browser — silently fall back to in-memory */
  }
}

// Singleton cache. Read once at module init; subsequent reads return
// the in-memory copy so callers don't pay the JSON parse cost per tick.
let cached: QueueState = loadFromStorage();

export function getQueueState(): QueueState {
  return cached;
}

export function setQueueChip(chip: QueueChip) {
  // Resetting page on chip change is intentional — see brief §9. Without
  // this, a rep filtering down to "Replied (3)" while on page 4 would see
  // an empty page and assume the chip is broken.
  cached = { ...cached, chip, pageIndex: 0 };
  saveToStorage(cached);
}

export function setQueuePageIndex(pageIndex: number) {
  const safe = Number.isFinite(pageIndex) && pageIndex >= 0 ? Math.floor(pageIndex) : 0;
  cached = { ...cached, pageIndex: safe };
  saveToStorage(cached);
}

/** Test/escape hatch — reset cache to defaults. Not used in production code. */
export function resetQueueState() {
  cached = { ...DEFAULT_STATE };
  saveToStorage(cached);
}
