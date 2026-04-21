// ============================================================
// Timeline Drift Audit & Safe Repair
// ------------------------------------------------------------
// Purpose: measure & repair drift between the legacy `interactions`
// table and the canonical `lead_timeline_items` ledger BEFORE we
// flip writes to be timeline-first.
//
// Reuse:
//   - Channel/direction inference is intentionally aligned with
//     `inferChannelFromType` in `src/lib/supabaseQueries.ts`
//     (kept in sync — see TODO below).
//   - Repair replays the EXACT projection shape used by
//     `insertInteraction` (same dedupe_key format `interaction:<id>`,
//     same upsert with `onConflict: 'lead_id,dedupe_key'`).
//
// New helper justified because:
//   - smokeTests.ts is pass/fail probes, not structured drift counts
//   - canonicalInteraction.ts lives in edge functions (Deno) and is
//     not callable from the browser
//   - we need preview + execute + report semantics with sample rows,
//     which doesn't fit either of the above.
//
// TODO(cleanup): once repair is run and residual drift is ~0, flip
// `insertInteraction` to write timeline-first and demote the
// `interactions` mirror to optional best-effort.
// ============================================================

import { supabase } from "@/integrations/supabase/client";

// ---------- Inference (aligned with supabaseQueries.ts) ----------

function inferChannelFromType(type: string): string {
  if (!type) return "system";
  if (type.includes("email")) return "email";
  if (type.includes("whatsapp")) return "whatsapp";
  if (type.includes("sms")) return "sms";
  if (type.includes("call") || type.includes("voice")) return "voice";
  if (type.includes("meeting")) return "meeting";
  return "system";
}

function inferDirectionFromType(type: string): "inbound" | "outbound" | null {
  if (!type) return null;
  if (type.includes("inbound")) return "inbound";
  if (type.includes("outbound")) return "outbound";
  return null;
}

// ---------- Types ----------

export interface DriftSampleRow {
  id: string;
  lead_id: string;
  type: string;
  source: string;
  occurred_at: string;
  subject: string | null;
}

export interface DriftAuditReport {
  scanned_interactions: number;
  missing_timeline_mirror: number;
  by_channel: Record<string, number>;
  by_source: Record<string, number>;
  by_age_bucket: Record<"24h" | "7d" | "30d" | "older", number>;
  sample_missing: DriftSampleRow[];

  orphan_timeline_rows: number;        // timeline rows whose source_id no longer exists in interactions
  orphan_sample: Array<{ id: string; lead_id: string; source_id: string; occurred_at: string }>;

  duplicate_dedupe_keys: number;       // (lead_id, dedupe_key) collisions in timeline
  duplicate_sample: Array<{ lead_id: string; dedupe_key: string }>;

  scan_window_days: number;
  scanned_at: string;
}

export interface RepairReport {
  attempted: number;
  repaired: number;
  skipped_missing_workspace: number;
  skipped_errors: number;
  error_samples: string[];
  finished_at: string;
}

// ---------- Audit ----------

const DEFAULT_WINDOW_DAYS = 30;
const SCAN_LIMIT = 1000;          // RLS/PostgREST default
const SAMPLE_SIZE = 10;

function ageBucket(occurredAt: string): "24h" | "7d" | "30d" | "older" {
  const ms = Date.now() - new Date(occurredAt).getTime();
  const day = 86_400_000;
  if (ms <= day) return "24h";
  if (ms <= 7 * day) return "7d";
  if (ms <= 30 * day) return "30d";
  return "older";
}

/**
 * Audit drift between `interactions` and `lead_timeline_items`.
 * Read-only. Safe to run against production.
 */
export async function auditTimelineDrift(
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<DriftAuditReport> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // 1) Pull a recent slice of interactions
  const { data: interactions, error: intErr } = await supabase
    .from("interactions")
    .select("id, lead_id, type, source, occurred_at, subject")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(SCAN_LIMIT);
  if (intErr) throw intErr;

  const ints = interactions ?? [];

  // 2) Pull timeline rows that bridge to interactions in the same window
  const { data: timeline, error: tlErr } = await supabase
    .from("lead_timeline_items")
    .select("id, lead_id, source_id, dedupe_key, occurred_at")
    .eq("source_table", "interactions")
    .gte("occurred_at", since)
    .limit(SCAN_LIMIT * 2);
  if (tlErr) throw tlErr;

  const tlRows = timeline ?? [];

  // Index timeline by source_id and by dedupe_key for O(1) lookup
  const tlBySourceId = new Set<string>();
  const tlByDedupeKey = new Set<string>();
  const dedupeKeyCount = new Map<string, number>();
  for (const t of tlRows) {
    if (t.source_id) tlBySourceId.add(t.source_id);
    if (t.dedupe_key) {
      tlByDedupeKey.add(t.dedupe_key);
      const key = `${t.lead_id}|${t.dedupe_key}`;
      dedupeKeyCount.set(key, (dedupeKeyCount.get(key) ?? 0) + 1);
    }
  }

  // 3) Find interactions with no timeline mirror
  const missing: typeof ints = [];
  const byChannel: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byAge: DriftAuditReport["by_age_bucket"] = { "24h": 0, "7d": 0, "30d": 0, older: 0 };

  for (const i of ints) {
    const expectedKey = `interaction:${i.id}`;
    const hasMirror = tlBySourceId.has(i.id) || tlByDedupeKey.has(expectedKey);
    if (hasMirror) continue;
    missing.push(i);
    const ch = inferChannelFromType(i.type);
    byChannel[ch] = (byChannel[ch] ?? 0) + 1;
    bySource[i.source ?? "unknown"] = (bySource[i.source ?? "unknown"] ?? 0) + 1;
    byAge[ageBucket(i.occurred_at)] += 1;
  }

  // 4) Orphan timeline rows: timeline.source_id pointing to non-existent interaction
  const intIdSet = new Set(ints.map((i) => i.id));
  const orphans = tlRows.filter((t) => t.source_id && !intIdSet.has(t.source_id));
  // Note: this is a heuristic within the same window — orphans outside the
  // window will not be flagged here. That's acceptable for this audit.

  // 5) Duplicate dedupe_keys per lead
  const dupes: Array<{ lead_id: string; dedupe_key: string }> = [];
  for (const [k, n] of dedupeKeyCount.entries()) {
    if (n > 1) {
      const [lead_id, dedupe_key] = k.split("|");
      dupes.push({ lead_id, dedupe_key });
    }
  }

  return {
    scanned_interactions: ints.length,
    missing_timeline_mirror: missing.length,
    by_channel: byChannel,
    by_source: bySource,
    by_age_bucket: byAge,
    sample_missing: missing.slice(0, SAMPLE_SIZE).map((i) => ({
      id: i.id,
      lead_id: i.lead_id,
      type: i.type,
      source: i.source ?? "unknown",
      occurred_at: i.occurred_at,
      subject: i.subject ?? null,
    })),
    orphan_timeline_rows: orphans.length,
    orphan_sample: orphans.slice(0, SAMPLE_SIZE).map((o) => ({
      id: o.id,
      lead_id: o.lead_id,
      source_id: o.source_id,
      occurred_at: o.occurred_at,
    })),
    duplicate_dedupe_keys: dupes.length,
    duplicate_sample: dupes.slice(0, SAMPLE_SIZE),
    scan_window_days: windowDays,
    scanned_at: new Date().toISOString(),
  };
}

// ---------- Repair ----------

/**
 * Idempotent repair: re-project missing `interactions` into
 * `lead_timeline_items` using the SAME shape as `insertInteraction`.
 *
 * Safe to re-run — uses upsert on (lead_id, dedupe_key).
 *
 * @param dryRun  When true, returns counts without writing.
 * @param maxRepairs  Hard cap to keep each run reviewable.
 */
export async function repairTimelineDrift(
  windowDays: number = DEFAULT_WINDOW_DAYS,
  options: { dryRun?: boolean; maxRepairs?: number } = {},
): Promise<RepairReport> {
  const dryRun = options.dryRun ?? true;
  const maxRepairs = options.maxRepairs ?? 200;

  const audit = await auditTimelineDrift(windowDays);
  const candidates = audit.sample_missing.length === audit.missing_timeline_mirror
    ? audit.sample_missing
    : await loadFullMissingList(windowDays, maxRepairs);

  const toRepair = candidates.slice(0, maxRepairs);

  // Resolve workspace_id per lead in bulk to avoid N+1
  const leadIds = Array.from(new Set(toRepair.map((r) => r.lead_id)));
  const wsMap = new Map<string, string>();
  if (leadIds.length > 0) {
    const { data: leads } = await supabase
      .from("leads")
      .select("id, workspace_id")
      .in("id", leadIds);
    for (const l of leads ?? []) {
      if (l.workspace_id) wsMap.set(l.id, l.workspace_id);
    }
  }

  // Pull full interaction rows for projection
  const intIds = toRepair.map((r) => r.id);
  const intMap = new Map<string, {
    id: string; lead_id: string; type: string; source: string | null;
    occurred_at: string; subject: string | null; body_text: string | null;
    direction: string | null;
  }>();
  if (intIds.length > 0) {
    const { data: full } = await supabase
      .from("interactions")
      .select("id, lead_id, type, source, occurred_at, subject, body_text, direction")
      .in("id", intIds);
    for (const r of full ?? []) intMap.set(r.id, r as any);
  }

  let repaired = 0;
  let skippedMissingWorkspace = 0;
  let skippedErrors = 0;
  const errorSamples: string[] = [];

  for (const cand of toRepair) {
    const ws = wsMap.get(cand.lead_id);
    if (!ws) {
      skippedMissingWorkspace += 1;
      continue;
    }
    const full = intMap.get(cand.id);
    if (!full) {
      skippedErrors += 1;
      if (errorSamples.length < 3) errorSamples.push(`missing full row for ${cand.id}`);
      continue;
    }

    const channel = inferChannelFromType(full.type);
    const direction = (full.direction as "inbound" | "outbound" | null)
      ?? inferDirectionFromType(full.type);
    const dedupeKey = `interaction:${full.id}`;

    if (dryRun) {
      repaired += 1;
      continue;
    }

    const { error } = await supabase.from("lead_timeline_items").upsert(
      {
        workspace_id: ws,
        lead_id: full.lead_id,
        channel,
        provider: full.source ?? "manual",
        direction,
        event_type: full.type,
        occurred_at: full.occurred_at,
        source_table: "interactions",
        source_id: full.id,
        subject: full.subject,
        snippet_text: (full.body_text ?? "").slice(0, 500),
        dedupe_key: dedupeKey,
      },
      { onConflict: "lead_id,dedupe_key" },
    );

    if (error) {
      skippedErrors += 1;
      if (errorSamples.length < 3) errorSamples.push(`${full.id}: ${error.message}`);
      // eslint-disable-next-line no-console
      console.warn("[timelineDriftRepair] failed", full.id, error.message);
    } else {
      repaired += 1;
    }
  }

  // eslint-disable-next-line no-console
  console.info(
    `[timelineDriftRepair] dryRun=${dryRun} attempted=${toRepair.length} repaired=${repaired} skippedMissingWS=${skippedMissingWorkspace} errors=${skippedErrors}`,
  );

  return {
    attempted: toRepair.length,
    repaired,
    skipped_missing_workspace: skippedMissingWorkspace,
    skipped_errors: skippedErrors,
    error_samples: errorSamples,
    finished_at: new Date().toISOString(),
  };
}

/**
 * When the audit sample alone isn't enough (large drift), pull the full
 * missing list up to `maxRepairs`. Bounded to keep memory predictable.
 */
async function loadFullMissingList(
  windowDays: number,
  maxRepairs: number,
): Promise<DriftSampleRow[]> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const [{ data: ints }, { data: tl }] = await Promise.all([
    supabase
      .from("interactions")
      .select("id, lead_id, type, source, occurred_at, subject")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(SCAN_LIMIT),
    supabase
      .from("lead_timeline_items")
      .select("source_id, dedupe_key")
      .eq("source_table", "interactions")
      .gte("occurred_at", since)
      .limit(SCAN_LIMIT * 2),
  ]);

  const seen = new Set<string>();
  for (const t of tl ?? []) {
    if (t.source_id) seen.add(t.source_id);
    if (t.dedupe_key) seen.add(t.dedupe_key);
  }

  const missing: DriftSampleRow[] = [];
  for (const i of ints ?? []) {
    if (missing.length >= maxRepairs) break;
    if (seen.has(i.id) || seen.has(`interaction:${i.id}`)) continue;
    missing.push({
      id: i.id,
      lead_id: i.lead_id,
      type: i.type,
      source: i.source ?? "unknown",
      occurred_at: i.occurred_at,
      subject: i.subject ?? null,
    });
  }
  return missing;
}
