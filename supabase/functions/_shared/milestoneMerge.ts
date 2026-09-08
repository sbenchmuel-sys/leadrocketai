// ============================================================
// milestoneMerge — pure, text-keyed milestone merge rules
//
// Shared by recompute-lead-intelligence (Deno), the lead-detail UI helpers in
// src/lib/supabaseQueries.ts and UploadTab. Pure on purpose: no Deno.*, no
// supabase client, so a vitest spec can import it directly.
//
// Rules (Unit L1, lead page audit):
//   • Identity is the description text (lower-cased, trimmed) — never the
//     array index, which shifts whenever the recompute reorders the list.
//   • When two entries collide, "completed" beats "pending" — a rep's manual
//     tick must survive the next recompute re-seeding the same milestone.
// ============================================================

export type MilestoneStatus = "completed" | "pending";

export interface MergeableMilestone {
  description: string;
  status?: string | null;
  date?: string | null;
  completedAt?: string;
}

export function milestoneKey(description: string | null | undefined): string {
  return (description ?? "").toLowerCase().trim();
}

/** "completed" wins over anything else; unknown/missing reads as "pending". */
export function higherMilestoneStatus(
  a: string | null | undefined,
  b: string | null | undefined,
): MilestoneStatus {
  return a === "completed" || b === "completed" ? "completed" : "pending";
}

/**
 * Merge `incoming` into `existing`, keyed by description text.
 * - Existing order is preserved; new descriptions are appended in incoming order.
 * - Duplicates inside either list collapse to the first occurrence.
 * - On collision the existing object is kept (evidence, ids…) with status
 *   escalated; date/completedAt are borrowed from the incoming entry when the
 *   escalation to "completed" came from it.
 */
export function mergeMilestonesByText<T extends MergeableMilestone>(
  existing: readonly T[] | null | undefined,
  incoming: readonly T[] | null | undefined,
): T[] {
  const out = new Map<string, T>();
  for (const m of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!m || typeof m.description !== "string") continue;
    const key = milestoneKey(m.description);
    if (!key) continue;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...m, status: higherMilestoneStatus(m.status, null) } as T);
      continue;
    }
    const status = higherMilestoneStatus(prev.status, m.status);
    const escalatedByIncoming = status === "completed" && prev.status !== "completed";
    out.set(key, {
      ...prev,
      status,
      date: prev.date ?? m.date ?? null,
      ...(escalatedByIncoming
        ? { date: m.date ?? prev.date ?? null, ...(m.completedAt ? { completedAt: m.completedAt } : {}) }
        : {}),
    } as T);
  }
  return [...out.values()];
}

/** Remove the milestone whose description matches `description` (text-keyed). */
export function removeMilestoneByText<T extends MergeableMilestone>(
  list: readonly T[] | null | undefined,
  description: string,
): T[] {
  const key = milestoneKey(description);
  return (list ?? []).filter((m) => milestoneKey(m?.description) !== key);
}

/** Set one milestone's status by description text; returns the new list (or the same list if not found). */
export function setMilestoneStatusByText<T extends MergeableMilestone>(
  list: readonly T[] | null | undefined,
  description: string,
  completed: boolean,
  nowIso: string,
): T[] {
  const key = milestoneKey(description);
  return (list ?? []).map((m) => {
    if (milestoneKey(m?.description) !== key) return m;
    return {
      ...m,
      status: completed ? "completed" : "pending",
      date: completed ? nowIso.split("T")[0] : (m.date ?? null),
      completedAt: completed ? nowIso : undefined,
    } as T;
  });
}
