// ============================================================
// queueQueries — data layer for the Queue page (/app/queue, PR D).
//
// Responsibilities:
//   1. `fetchQueueLeads()`  → workspace-scoped leads with needs_action,
//      not-snoozed, not-permanently-dismissed. RLS handles workspace.
//   2. `fetchLatestInbounds()` → bulk-fetch latest email_inbound row
//      per lead for the VISIBLE page only (used for ai_summary +
//      snippet_text + intent annotation on cards).
//   3. `fetchVisibleQueueLeadsCount()` → lightweight count for the
//      30s background poll that drives the "N new items" banner.
//      Returns the count AFTER intent-hide and AFTER chip filter so
//      banner deltas mean "new items the rep would actually see".
//   4. `chipForLead()` / `INTENT_HIDE_FROM_QUEUE` re-export — the
//      Queue page consumes the same hide-set as the CommandStrip
//      badge (PR C) so both stay in sync.
//
// Sort order: `QUEUE_URGENCY_PRIORITY[next_action_key]` then
// `last_inbound_at DESC`. Extends PriorityActions's URGENCY_PRIORITY
// to cover OOO-return and post-meeting follow-ups so customer-waiting
// rows surface above rep-waiting rows (brief §3 trust requirement).
//
// Intent-hide list mirrors INTENT_HIDE_FROM_QUEUE from dashboardUtils
// PLUS `meeting_confirmation` and `unsubscribe` (six total, per
// brief §2). I extend the existing set rather than redefine it so the
// CommandStrip badge and the Queue page can never drift apart.
// ============================================================

import { supabase } from "@/integrations/supabase/client";
import { INTENT_HIDE_FROM_QUEUE as BASE_HIDE_SET } from "@/lib/dashboardUtils";

// ── Queue-side hide list (extends dashboard hide list) ─────────────

/**
 * Intents that hide a lead from the Queue. Six values, per brief §2:
 *   calendar_accept, ooo_reply, bounce, zoom_recap,
 *   meeting_confirmation, unsubscribe.
 *
 * Built from the dashboard set + two queue-only extensions. Keep this
 * derived (not literal) so the dashboard CommandStrip badge stays a
 * strict superset — a lead the queue hides must also be removed from
 * the action_required badge count (PR C invariant).
 */
export const QUEUE_INTENT_HIDE_SET: ReadonlySet<string> = new Set([
  ...Array.from(BASE_HIDE_SET),
  "meeting_confirmation",
  "unsubscribe",
]);

// ── Sort priority ──────────────────────────────────────────────────

/**
 * Extends `URGENCY_PRIORITY` from PriorityActions.tsx:28–35. Lower
 * number = higher priority. Customer-waiting actions (reply, OOO
 * back) sort above rep-waiting (follow-up, nurture).
 *
 * Aligned with PriorityActions for shared keys; values for new keys
 * are interleaved without bumping the originals (so the dashboard
 * sort doesn't drift).
 */
const QUEUE_URGENCY_PRIORITY: Record<string, number> = {
  reply_now: 1,
  ooo_return_followup: 1, // OOO back is customer-waiting equivalent
  generate_post_meeting_recap: 2,
  send_proposal: 3,
  closing_followup: 3,
  post_meeting_followup: 4,
  send_pre_2: 5,
  send_pre_3: 6,
  send_pre_4: 7,
  reengage: 8,
  switch_to_nurture: 9,
};

function urgencyOf(key: string | null | undefined): number {
  if (!key) return 100; // unknown / null sort to the bottom
  if (QUEUE_URGENCY_PRIORITY[key] != null) return QUEUE_URGENCY_PRIORITY[key];
  // Nurture sequence buckets — every send_nurture_N collapses to 9.
  if (key.startsWith("send_nurture_")) return 9;
  return 100;
}

// ── Chip classification ────────────────────────────────────────────

export type QueueChipBucket = "replied" | "followup_due" | "ooo_back";

const RESURFACED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Map a lead's next_action_key + action_resurfaced_at to a chip bucket.
 *
 * Documented in the PR description for operator approval. Summary:
 *  - **Replied** = customer is waiting. Just `reply_now`.
 *  - **OOO back** = `ooo_return_followup` (explicit), OR ANY action
 *    where `action_resurfaced_at` is within the last 24h (covers
 *    re-arm via fresh inbound during a snooze).
 *  - **Follow-up due** = everything else with a non-null action key.
 *    Lower-friction default per brief §4 ("better to undercount
 *    Replied than overcount it and erode trust").
 *
 * Returns `null` if the lead has no action key (defensive — shouldn't
 * happen for queue rows since they pass `needs_action = true`).
 */
export function chipForLead(input: {
  next_action_key: string | null;
  action_resurfaced_at: string | null;
}): QueueChipBucket | null {
  const { next_action_key, action_resurfaced_at } = input;

  // OOO back — explicit or recently re-armed.
  if (next_action_key === "ooo_return_followup") return "ooo_back";
  if (action_resurfaced_at) {
    const resurfacedAt = new Date(action_resurfaced_at).getTime();
    if (Number.isFinite(resurfacedAt) && Date.now() - resurfacedAt < RESURFACED_WINDOW_MS) {
      return "ooo_back";
    }
  }

  // Replied — customer is the one waiting.
  if (next_action_key === "reply_now") return "replied";

  // Follow-up due — default for anything else with an action key.
  if (next_action_key) return "followup_due";

  return null;
}

// ── Types ──────────────────────────────────────────────────────────

export interface QueueLeadRow {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  action_reason_code: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  action_dismissed_at: string | null;
  action_permanently_dismissed: boolean;
  action_resurfaced_at: string | null;
  motion: string | null;
  stage: string | null;
  whatsapp_number: string | null;
  phone: string | null;
  wa_opted_in: boolean | null;
  sms_opted_in: boolean | null;
  country: string | null;
}

export interface QueueLatestInbound {
  lead_id: string;
  occurred_at: string;
  ai_summary: string | null;
  snippet_text: string | null;
  intent: string | null;
}

const QUEUE_LEAD_COLUMNS = `
  id, name, company, email,
  needs_action, next_action_key, next_action_label, action_reason_code,
  last_inbound_at, last_outbound_at,
  action_dismissed_at, action_permanently_dismissed, action_resurfaced_at,
  motion, stage,
  whatsapp_number, phone, wa_opted_in, sms_opted_in, country
`;

// ── List fetch ─────────────────────────────────────────────────────

/**
 * Fetch all queue-candidate leads in the user's workspace, post the
 * intent-hide reduction. Sort applied client-side via
 * `QUEUE_URGENCY_PRIORITY` then `last_inbound_at DESC`. Caller paginates.
 *
 * Returns both the visible array and the `hiddenCount` for the
 * "N routine items hidden · show all" header (brief §2). Counting
 * happens here so the page doesn't have to refetch when the show-all
 * toggle flips.
 */
export async function fetchQueueLeads(opts?: {
  showAll?: boolean;
}): Promise<{ leads: QueueLeadRow[]; hiddenCount: number }> {
  const nowIso = new Date().toISOString();

  // Step 1 — pull queue-candidate leads. The three filters narrow this
  // hard:
  //   `needs_action = true`                  (the gating flag)
  //   `action_permanently_dismissed = false` (cleared by syncEngine on
  //                                           fresh inbound; PR B)
  //   `action_dismissed_at IS NULL OR < now` (snooze expired)
  //
  // No `.order()` or `.limit()` — earlier revisions had
  // `.order("last_inbound_at" DESC).limit(500)`, which truncated the
  // result BEFORE the client-side urgency sort. A `reply_now` lead
  // with an old `last_inbound_at` (high urgency, old timestamp) could
  // fall outside the 500-row window and silently disappear from the
  // queue — even though urgency-wise it should sort to the top. Same
  // shape of bug PR C fixed for `intentHiddenIds` (CommandStrip
  // overcount). Codex P1 on PR #46.
  //
  // The actionable set is bounded by the three filters above. PostgREST's
  // `db-max-rows` is the upstream safety net — if a workspace ever
  // exceeds that (well into the thousands of simultaneously-actionable
  // leads), surfacing the error is the right call, not silently
  // dropping the highest-priority rows.
  const { data: leadRows, error: leadsErr } = await supabase
    .from("leads")
    .select(QUEUE_LEAD_COLUMNS)
    .eq("needs_action", true)
    .eq("action_permanently_dismissed", false)
    .or(`action_dismissed_at.is.null,action_dismissed_at.lt.${nowIso}`);

  if (leadsErr) {
    console.error("[queueQueries] leads fetch error:", leadsErr);
    throw leadsErr;
  }

  const leads = (leadRows ?? []) as unknown as QueueLeadRow[];
  if (leads.length === 0) return { leads: [], hiddenCount: 0 };

  // Step 2 — pull the per-lead latest intent via the shared RPC.
  // The RPC is workspace-scoped (SECURITY DEFINER + is_workspace_member),
  // so any lead ID we don't own is silently dropped. Non-fatal on failure.
  const leadIds = leads.map((l) => l.id);
  const hiddenSet = await fetchHiddenLeadIds(leadIds);

  // Step 3 — split visible vs hidden.
  let visible = leads.filter((l) => !hiddenSet.has(l.id));
  const hiddenCount = leads.length - visible.length;

  if (opts?.showAll) {
    // Show-all reveals everything but keeps the ranked sort.
    visible = leads;
  }

  // Step 4 — sort: urgency asc, then last_inbound_at desc.
  visible.sort((a, b) => {
    const ua = urgencyOf(a.next_action_key);
    const ub = urgencyOf(b.next_action_key);
    if (ua !== ub) return ua - ub;
    const ta = a.last_inbound_at ? new Date(a.last_inbound_at).getTime() : 0;
    const tb = b.last_inbound_at ? new Date(b.last_inbound_at).getTime() : 0;
    return tb - ta;
  });

  return { leads: visible, hiddenCount };
}

/** Run the intent RPC and reduce to a Set of lead IDs to hide. */
async function fetchHiddenLeadIds(leadIds: string[]): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();

  const { data, error } = await supabase.rpc("get_latest_intents_for_leads", {
    p_lead_ids: leadIds,
  });

  if (error) {
    // Non-fatal — fall back to "no hidden ids" so the queue renders
    // identical to pre-intent-classifier behaviour rather than erroring out.
    // Mirrors the dashboard's degrade-gracefully posture.
    console.warn("[queueQueries] intent fetch failed:", error.message);
    return new Set();
  }

  const hidden = new Set<string>();
  for (const row of (data ?? []) as Array<{ lead_id: string; intent: string | null }>) {
    if (row.intent && QUEUE_INTENT_HIDE_SET.has(row.intent)) {
      hidden.add(row.lead_id);
    }
  }
  return hidden;
}

// ── Latest inbound bulk fetch (for visible page) ──────────────────

/**
 * Bulk-fetch the latest `email_inbound` row per lead for the visible
 * page. Used to populate `ai_summary` + `snippet_text` + `intent`
 * annotation on Queue cards.
 *
 * Bounded query: we cap at 500 rows and reduce to first-per-lead.
 * Visible page is ≤25 leads (one pagination window), so 500 is
 * comfortably ample even for chatty threads — but on the rare lead
 * with >20 inbounds, the latest may fall outside the window. In that
 * (unlikely) case the card degrades cleanly: no ai_summary →
 * snippet_text fallback in `cleanBodyText`; no intent → why-now
 * shows "category · time" without the trailing context phrase. Safe
 * by design.
 *
 * If this becomes a real problem in production, the right fix is a
 * dedicated RPC like `get_latest_inbound_for_leads(uuid[])` — same
 * shape as `get_latest_intents_for_leads`. Out of scope for PR D.
 */
export async function fetchLatestInbounds(
  leadIds: string[],
): Promise<Map<string, QueueLatestInbound>> {
  if (leadIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("lead_timeline_items")
    .select("lead_id, occurred_at, snippet_text, metadata_json, intent")
    .in("lead_id", leadIds)
    .eq("event_type", "email_inbound")
    .order("occurred_at", { ascending: false })
    .limit(500);

  if (error) {
    console.warn("[queueQueries] latest inbound fetch failed:", error.message);
    return new Map();
  }

  const map = new Map<string, QueueLatestInbound>();
  for (const row of (data ?? []) as Array<{
    lead_id: string;
    occurred_at: string;
    snippet_text: string | null;
    metadata_json: Record<string, unknown> | null;
    intent: string | null;
  }>) {
    // First occurrence wins because of the desc sort — same pattern
    // the RPC uses server-side. Skip if we already have one.
    if (map.has(row.lead_id)) continue;
    const meta = row.metadata_json ?? {};
    map.set(row.lead_id, {
      lead_id: row.lead_id,
      occurred_at: row.occurred_at,
      ai_summary: typeof meta.ai_summary === "string" ? (meta.ai_summary as string) : null,
      snippet_text: row.snippet_text,
      intent: row.intent,
    });
  }
  return map;
}

// ── Count for poll ─────────────────────────────────────────────────

/**
 * Lightweight count of queue-candidate leads matching the rep's
 * current chip filter, AFTER intent-hide. Used by `useQueueSnapshot`
 * every 30s to drive the "N new items — refresh" banner.
 *
 * Implementation: re-runs the full snapshot query (cheap — same
 * shape as `fetchQueueLeads` but without sorting and without
 * pagination state). Doesn't bypass intent-hide so the delta the rep
 * sees matches what they'd actually get on refresh.
 *
 * Brief §8: "Do not try to be clever about WHICH items are new —
 * just the count delta." So no incremental diff / change-tracking —
 * just a fresh count.
 */
export async function fetchVisibleQueueLeadsCount(opts?: {
  chip?: QueueChipBucket | null;
}): Promise<number> {
  const { leads } = await fetchQueueLeads({ showAll: false });
  if (!opts?.chip) return leads.length;
  return leads.filter(
    (l) =>
      chipForLead({
        next_action_key: l.next_action_key,
        action_resurfaced_at: l.action_resurfaced_at,
      }) === opts.chip,
  ).length;
}

// ── Chip-bucket counts for chip strip ─────────────────────────────

export interface QueueChipCounts {
  replied: number;
  followup_due: number;
  ooo_back: number;
  total: number;
}

export function countChipBuckets(leads: QueueLeadRow[]): QueueChipCounts {
  let replied = 0;
  let followup_due = 0;
  let ooo_back = 0;
  for (const l of leads) {
    const bucket = chipForLead({
      next_action_key: l.next_action_key,
      action_resurfaced_at: l.action_resurfaced_at,
    });
    if (bucket === "replied") replied += 1;
    else if (bucket === "followup_due") followup_due += 1;
    else if (bucket === "ooo_back") ooo_back += 1;
  }
  return { replied, followup_due, ooo_back, total: leads.length };
}

// ── Sort + chip filter helpers (pure) ─────────────────────────────

/**
 * Apply the rep's chip filter to a snapshot. Pure function — never
 * triggers a re-fetch. The snapshot stays stable while the rep
 * toggles chips.
 */
export function applyChipFilter(
  leads: QueueLeadRow[],
  chip: QueueChipBucket | null,
): QueueLeadRow[] {
  if (!chip) return leads;
  return leads.filter(
    (l) =>
      chipForLead({
        next_action_key: l.next_action_key,
        action_resurfaced_at: l.action_resurfaced_at,
      }) === chip,
  );
}

// ── Per-lead button label ─────────────────────────────────────────

export type QueueButtonLabel = "Reply" | "Follow up";

/**
 * Brief §6: button label switches between "Reply" and "Follow up"
 * based on next_action_key. Customer-waiting → "Reply".
 *
 * Mapping mirrors `chipForLead`: anything that buckets into "replied"
 * OR "ooo_back" is customer-waiting; everything else is rep-waiting.
 * Single source of truth means button label and chip always agree.
 */
export function queueButtonLabel(input: {
  next_action_key: string | null;
  action_resurfaced_at: string | null;
}): QueueButtonLabel {
  const bucket = chipForLead(input);
  if (bucket === "replied" || bucket === "ooo_back") return "Reply";
  return "Follow up";
}
