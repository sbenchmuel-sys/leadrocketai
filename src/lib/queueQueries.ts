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
import { getLeadEmailThread } from "@/lib/supabaseQueries";
import { INTENT_HIDE_FROM_QUEUE as BASE_HIDE_SET } from "@/lib/dashboardUtils";
import { FOLLOWUP_DUE_KEY, PROMPT_ONLY_KEYS } from "@shared/followupRule";

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

/**
 * Canonical inbound `lead_timeline_items.event_type` values.
 *
 * These are the three `*_inbound` types the write paths actually emit:
 * gmail-sync / outlook-sync / outlook-webhook write `email_inbound`,
 * whatsapp-events-processor writes `whatsapp_inbound`, sms-webhook
 * writes `sms_inbound` (see `_shared/canonicalInteraction.ts` and the
 * ChannelBadge map in `src/components/lead/TimelineTab.tsx`).
 *
 * The Queue used to hard-filter `email_inbound` here AND inside
 * `get_latest_intents_for_leads`, so a lead whose latest (or only)
 * inbound was a WhatsApp or SMS reply got no preview row at all and
 * rendered a blank card. Both sides now use this set; the SQL half
 * lives in `supabase/migrations/20260908120000_queue_intent_rpc.sql`
 * and is pinned by `src/lib/queueQueries.test.ts`.
 */
export const INBOUND_EVENT_TYPES: readonly string[] = [
  "email_inbound",
  "whatsapp_inbound",
  "sms_inbound",
];

/**
 * Canonical OUTBOUND `lead_timeline_items.event_type` values — the mirror of
 * `INBOUND_EVENT_TYPES`. A follow-up card is about MY unanswered message, so the
 * card body has to be able to read my side of the ledger too; before Unit Q2 the
 * Queue only ever fetched inbound rows, so every follow-up card showed the
 * customer's last message under a "Follow up" heading — the wrong message
 * entirely.
 */
export const OUTBOUND_EVENT_TYPES: readonly string[] = [
  "email_outbound",
  "whatsapp_outbound",
  "sms_outbound",
];

/**
 * A completed OUTBOUND phone call is an outbound touch like any other, and the
 * Queue has to know about it: `twilio-voice-webhook` writes a `voice_outbound`
 * `interactions` row and then calls `postSendDeriveAction`, which recomputes
 * `leads.last_outbound_at` from interactions — so a follow-up card can be timed
 * off a CALL. With only the three written channels above in the preview fetch,
 * that card quoted whatever email happened to be next-newest, possibly weeks
 * old, under a caption saying "Your message". Confident, and about a different
 * conversation.
 *
 * Only `call_completed` matters here. The webhook projects `call_failed`,
 * `call_busy`, `call_no-answer` and `call_canceled` too, but it writes the
 * interactions row and recomputes ONLY for `status === "completed" &&
 * direction === "outbound"` — so no other call event can move
 * `last_outbound_at`, and none of them should ever claim a card.
 *
 * NOTE the direction check at the call site: inbound calls produce a
 * `call_completed` row as well, and one of those is emphatically not "your
 * last outbound".
 */
export const OUTBOUND_CALL_EVENT_TYPE = "call_completed";

/**
 * The meeting row `process-zoom-summary` projects: `subject` is the meeting
 * title, `snippet_text` the first 500 chars of the summary. It is what a recap
 * card is actually about.
 *
 * Present only for meetings a Zoom summary matched — `hasMeetingWithoutFollowup`
 * is derived from `meeting_packs`, which can exist without one. So the recap
 * card shows meeting context WHEN THE LEDGER HAS IT and shows nothing when it
 * does not; it never falls back to a written message, because by construction
 * there is no outbound after the meeting (gmail-sync only sets the flag when no
 * outbound interaction exists after the meeting date) and the newest outbound is
 * therefore a pre-meeting email.
 *
 * `snippet_text` on this row purges at 72h like every non-inbound row, leaving
 * the title — which is why the body goes through `cleanBodyText`'s subject
 * fallback rather than quoting `snippet_text` directly.
 */
export const MEETING_EVENT_TYPE = "meeting";

/** What `fetchLatestOutbounds` asks the ledger for. */
export const OUTBOUND_PREVIEW_EVENT_TYPES: readonly string[] = [
  ...OUTBOUND_EVENT_TYPES,
  OUTBOUND_CALL_EVENT_TYPE,
];

/** Is this preview row a phone call rather than something with words in it? */
export function isOutboundCall(row: { event_type: string } | null | undefined): boolean {
  return row?.event_type === OUTBOUND_CALL_EVENT_TYPE;
}

/**
 * What to show where a quoted message would go, when the last outbound was a
 * call. Duration comes from `metadata_json.duration_sec`, which the webhook
 * always writes.
 *
 * It says nothing about how the call WENT. The timeline row carries
 * `{ call_sid, duration_sec, status }` and `status` is "completed" for every row
 * that can reach here, so there is no answered-by-a-human vs went-to-voicemail
 * signal to read. Length is the only honest hint, and the rep knows the rest.
 */
export function describeOutboundCall(row: { duration_sec?: number | null } | null | undefined): string {
  const secs = row?.duration_sec;
  if (typeof secs === "number" && Number.isFinite(secs) && secs > 0) {
    return `You called them — ${Math.max(1, Math.ceil(secs / 60))} min`;
  }
  return "You called them";
}

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
  ooo_return_followup: 1, // back-from-away — keep at top of Follow up
  generate_post_meeting_recap: 2,
  send_proposal: 3,
  closing_followup: 3,
  post_meeting_followup: 4,
  send_pre_2: 5,
  send_pre_3: 6,
  send_pre_4: 7,
  followup_due: 8, // Unit Q1: my message, unanswered N days — real rep work.
  reengage: 8,
  switch_to_nurture: 9,
  // A send guardrail is holding this lead. It is visible on purpose (it used
  // to vanish silently) but it is the least urgent thing in the tab — the rep
  // can't act on it until the date in its label.
  rate_limited: 50,
};

export function urgencyOf(key: string | null | undefined): number {
  if (!key) return 100; // unknown / null sort to the bottom
  if (QUEUE_URGENCY_PRIORITY[key] != null) return QUEUE_URGENCY_PRIORITY[key];
  // Nurture sequence buckets — every send_nurture_N collapses to 9.
  if (key.startsWith("send_nurture_")) return 9;
  return 100;
}

// ── Chip classification ────────────────────────────────────────────

export type QueueChipBucket = "replied" | "followup_due";

/**
 * "Was away — back now": the lead was paused out-of-office and has now
 * returned. The only signal is the `ooo_return_followup` action key
 * written by the OOO detector (`_shared/oooPauseActions.ts applyOOOPause`).
 *
 * A lead that merely re-armed because a fresh inbound landed
 * (`action_resurfaced_at` within 24h) is deliberately NOT treated as
 * "was away" — that path now falls to its natural group: a genuine
 * reply (`reply_now`) goes to "Replied", anything else to "Follow up".
 * Conflating the two previously mislabeled real replies as OOO.
 *
 * Front-end relabel only: the detector and the automation send-pause are
 * unchanged; we only reinterpret the key the detector already writes.
 */
export function leadWasAway(input: { next_action_key: string | null }): boolean {
  return input.next_action_key === "ooo_return_followup";
}

/**
 * Map a lead's next_action_key to a chip bucket.
 *
 *  - **Replied** = customer is waiting (`reply_now`).
 *  - **Follow up** = everything else with a non-null action key,
 *    INCLUDING back-from-away leads (`ooo_return_followup`). Those fold
 *    in here with a "was away — back now" note on the card rather than a
 *    separate OOO group. Lower-friction default per brief §4 ("better to
 *    undercount Replied than overcount it and erode trust").
 *
 * Was-away is checked first so a back-from-away lead never sits under
 * "Replied" — the rep is the one following up, not replying.
 *
 * `action_resurfaced_at` is retained in the input shape for caller
 * compatibility but no longer affects bucketing (see `leadWasAway`).
 *
 * Returns `null` if the lead has no action key (defensive — shouldn't
 * happen for queue rows since they pass `needs_action = true`).
 */
export function chipForLead(input: {
  next_action_key: string | null;
  action_resurfaced_at: string | null;
}): QueueChipBucket | null {
  const { next_action_key } = input;

  // Back-from-away → Follow up (rep follows up; note shown on card).
  if (leadWasAway({ next_action_key })) return "followup_due";

  // Replied — customer is the one waiting.
  if (next_action_key === "reply_now") return "replied";

  // Follow up — default for anything else with an action key, including the
  // two Unit Q1 keys (`followup_due`, `rate_limited`). Both are the rep's own
  // move, so neither ever belongs under "Replied".
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
  /** The clock `send_nurture_N` is scheduled from (syncEngine branch E). */
  last_nurture_outbound_at: string | null;
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
  // Active campaign enrollment — when set, the lead's cold cadence is handled
  // from the Outreach tab; we hide it from Replied/Follow-up unless the
  // customer actually replied (next_action_key === 'reply_now'). Outreach
  // volume must not flood the reactive lists.
  campaign_id: string | null;
}

export interface QueueLatestInbound {
  lead_id: string;
  occurred_at: string;
  ai_summary: string | null;
  snippet_text: string | null;
  subject: string | null;
  intent: string | null;
  /** Which `*_inbound` event type this row is — drives the card's channel hint. */
  event_type: string;
  /** `metadata_json.ai_signals.*`, persisted by classify-inbound. NULL = unknown. */
  reply_worthy: boolean | null;
  urgency: string | null;
  tone: string | null;
  questions_extracted: string[];
  language: string | null;
  /** `metadata_json.sender_is_lead`. NULL = couldn't tell. */
  sender_is_lead: boolean | null;
}

/**
 * Same row shape, either direction. A follow-up card quotes an OUTBOUND row, so
 * the "Inbound" in the original name is only true half the time; the alias keeps
 * the existing exported name (TodoView, tests) working.
 */
export type QueueLatestMessage = QueueLatestInbound & {
  /** Call rows only: `metadata_json.duration_sec`. Undefined for written messages. */
  duration_sec?: number | null;
};

const QUEUE_LEAD_COLUMNS = `
  id, name, company, email,
  needs_action, next_action_key, next_action_label, action_reason_code,
  last_inbound_at, last_outbound_at, last_nurture_outbound_at,
  action_dismissed_at, action_permanently_dismissed, action_resurfaced_at,
  motion, stage,
  whatsapp_number, phone, wa_opted_in, sms_opted_in, country,
  campaign_id
`;

// ── List fetch ─────────────────────────────────────────────────────

/**
 * Does an outreach-enrolled lead belong in the reactive tabs (Replied / Follow
 * up) rather than the Outreach tab? Extracted so it is testable — the rules are
 * spelled out at the call site in `fetchQueueLeads`.
 */
export function belongsInReactiveTabs(
  lead: {
    campaign_id?: string | null;
    next_action_key?: string | null;
    last_inbound_at?: string | null;
    last_outbound_at?: string | null;
  },
  opts: { hasLiveEnrollment?: boolean } = {},
): boolean {
  if (!lead.campaign_id) return true;
  if (lead.next_action_key === "reply_now") return true;
  // Unit Q1: a PROMPT key — `followup_due` or `rate_limited` — is the rep's own
  // thread to pick up, so it belongs in the reactive tabs ONCE the cold
  // enrollment is genuinely over. The condition is about enrollment state, not
  // about which key: keying it on the key is what made this line oscillate
  // between too broad (campaign volume flooding Follow up while cadences were
  // still running) and too narrow (a rep who answered a campaign prospect, then
  // tripped a volume cap on that reply, saw the lead in neither the terminal
  // campaign nor the Queue).
  //
  // `hasLiveEnrollment` is the caller's answer to "is the cadence still working
  // this lead?" — a scheduled / active / paused enrollment. While that is true
  // the Outreach tab owns the lead and neither key gets in; once it is false the
  // enrollment is terminal (replied / stopped / completed) and nothing else
  // would ever show the lead.
  if (PROMPT_ONLY_KEYS.has(lead.next_action_key ?? "") && !opts.hasLiveEnrollment) return true;
  if (!lead.last_inbound_at) return false;
  if (!lead.last_outbound_at) return true;
  return new Date(lead.last_inbound_at).getTime() > new Date(lead.last_outbound_at).getTime();
}

/**
 * Enrollment states that mean the cold cadence is STILL working this lead, so
 * the Outreach tab — not the Queue — owns it. `endColdEnrollment` moves a row to
 * replied / stopped / completed, which is what "the enrollment has ended" means.
 */
const LIVE_ENROLLMENT_STATUSES = ["scheduled", "active", "paused"] as const;

/**
 * Ids per `.in()` filter. PostgREST puts the whole list in the query STRING, so
 * an unchunked lookup grows with the workspace's campaign-lead count: ~37 bytes
 * per UUID means a few thousand leads blows the server's URL limit and the
 * query 400s. Because this lookup fails toward visibility, that would not crash
 * the Queue — it would quietly fill it with campaign leads, which is worse than
 * a crash to diagnose. 100 ids ≈ 3.7 KB of URL, comfortably inside any limit,
 * and the number of round-trips stays tiny for any realistic workspace.
 */
const ENROLLMENT_LOOKUP_CHUNK = 100;

/** Which of these leads still have a live cold enrollment? */
async function fetchLiveEnrollmentLeadIds(leadIds: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  for (let i = 0; i < leadIds.length; i += ENROLLMENT_LOOKUP_CHUNK) {
    const chunk = leadIds.slice(i, i + ENROLLMENT_LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from("campaign_enrollment")
      .select("lead_id")
      .in("lead_id", chunk)
      .in("status", LIVE_ENROLLMENT_STATUSES as unknown as string[]);
    if (error) {
      // Fail toward VISIBILITY, per chunk: an owed follow-up the rep can't see
      // is the bug this unit exists to fix, and the cost of being wrong the
      // other way is a handful of campaign leads appearing in Follow up early.
      // Logged with the chunk bounds so a partial failure is diagnosable rather
      // than showing up as "the Queue looks odd".
      console.error(
        `[queueQueries] enrollment lookup failed for leads ${i}-${i + chunk.length - 1} of ${leadIds.length}:`,
        error,
      );
      continue;
    }
    for (const r of (data ?? []) as Array<{ lead_id: string }>) live.add(r.lead_id);
  }
  return live;
}

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

  // Outreach-enrolled leads belong to the dedicated "Outreach" tab — the cold
  // cadence is driven by campaign_touch rows, not by needs_action. Two ways an
  // enrolled lead earns a spot in the reactive tabs:
  //   1. next_action_key === 'reply_now'  → routes to "Replied".
  //   2. the customer has an UNANSWERED inbound (last_inbound_at is newer than
  //      last_outbound_at) → the lead is no longer purely cold, so the reactive
  //      tabs own it even if the derived action key is something else
  //      (post-meeting recap, closing follow-up, back-from-away, …).
  // Rule 2 is the safety net: if the server-side derivation ever fails to write
  // `reply_now` (rate-limit guardrails, an armed cadence touch), the reply is
  // still visible here instead of vanishing. Purely cold leads — no inbound at
  // all — stay in the Outreach tab so reactive lists aren't flooded.
  //
  // Rule 3 (Unit Q1, Codex P1): a HUMAN-PROMPT key is never cold campaign work,
  // so it belongs in the reactive tabs whatever the lead's origin. The flow that
  // needs this: a campaign prospect replies → the enrolment is stopped → the rep
  // answers → days pass with no response → `followup_due`. That lead has its
  // outbound NEWER than its inbound, so rule 2 rejects it, and
  // `endColdEnrollment` does not clear `leads.campaign_id`, so it showed up in
  // neither the Follow up list nor the stopped campaign's Outreach touches. The
  // six-week hole, still open for every lead that started life in a campaign.
  // `rate_limited` gets the same treatment for the same reason — it is the rep's
  // own follow-up, merely held, and the Outreach tab has nothing to show for it.
  // Only campaign leads carrying a prompt key need the enrollment lookup —
  // every other row is decided without it, so the common case costs no query.
  const campaignFollowupIds = (leadRows ?? [])
    .filter((l: any) => l.campaign_id && PROMPT_ONLY_KEYS.has(l.next_action_key ?? ""))
    .map((l: any) => l.id as string);

  const liveEnrollmentLeadIds = campaignFollowupIds.length > 0
    ? await fetchLiveEnrollmentLeadIds(campaignFollowupIds)
    : new Set<string>();

  const filteredForOutreach = (leadRows ?? []).filter((l: any) =>
    belongsInReactiveTabs(l, { hasLiveEnrollment: liveEnrollmentLeadIds.has(l.id) })
  );


  const leads = filteredForOutreach as unknown as QueueLeadRow[];
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

/**
 * Row shape returned by `get_latest_intents_for_leads` after migration
 * 20260908120000_queue_intent_rpc.sql.
 *
 * ponytail: typed locally rather than off `Database["public"]["Functions"]`
 * because `src/integrations/supabase/types.ts` is generated by Lovable and
 * still describes the two-column version. Delete this interface once
 * Lovable regenerates types after applying the migration.
 */
interface LatestIntentRow {
  lead_id: string;
  intent: string | null;
  reply_worthy: boolean | null;
  sender_is_lead: boolean | null;
}

/**
 * Decide whether the lead's LATEST inbound means "don't put this on the
 * rep's board". Pure so it can be unit-tested without a DB.
 *
 * Three independent reasons, any of which hides (all fail OPEN — an
 * unknown value never hides):
 *   1. the intent is routine noise (bounce, OOO, calendar accept, …);
 *   2. the model said the message needs no reply (`reply_worthy=false`);
 *   3. the sender is demonstrably not the lead — a colleague, assistant
 *      or vendor on the thread, who should not fire "Reply to customer".
 *
 * Nothing is deleted: every hidden lead is counted into `hiddenCount`
 * and revealed by the Queue's existing "N routine items hidden ·
 * show all" toggle.
 */
export function shouldHideFromQueue(row: {
  intent: string | null;
  reply_worthy: boolean | null;
  sender_is_lead: boolean | null;
}): boolean {
  if (row.intent && QUEUE_INTENT_HIDE_SET.has(row.intent)) return true;
  if (row.reply_worthy === false) return true;
  if (row.sender_is_lead === false) return true;
  return false;
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
  // ponytail: cast — see LatestIntentRow. Older deployments (migration not
  // yet applied) simply return the two legacy columns, which read as
  // `undefined` here and are normalized to null, i.e. "not hidden".
  for (const row of (data ?? []) as unknown as LatestIntentRow[]) {
    if (
      shouldHideFromQueue({
        intent: row.intent ?? null,
        reply_worthy: row.reply_worthy ?? null,
        sender_is_lead: row.sender_is_lead ?? null,
      })
    ) {
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
 *
 * `subject` is selected as a final fallback for `cleanBodyText`. The 72h
 * raw-body purge (message-cleanup) nulls `snippet_text` past
 * `occurred_at + 72h`, while `subject` is preserved metadata. Without
 * the subject fallback, every Follow-up-due card (latest inbound is
 * typically days old) renders "[No preview available]". `ai_summary`
 * isn't written by the inbound sync paths today (gmail-sync doesn't
 * pass it, classify-inbound only writes `intent`), so it almost never
 * fills the gap.
 */
export async function fetchLatestInbounds(
  leadIds: string[],
): Promise<Map<string, QueueLatestInbound>> {
  if (leadIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("lead_timeline_items")
    .select("lead_id, occurred_at, event_type, snippet_text, subject, metadata_json, intent")
    .in("lead_id", leadIds)
    .in("event_type", INBOUND_EVENT_TYPES as string[])
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
    event_type: string;
    snippet_text: string | null;
    subject: string | null;
    metadata_json: Record<string, unknown> | null;
    intent: string | null;
  }>) {
    // First occurrence wins because of the desc sort — same pattern
    // the RPC uses server-side. Skip if we already have one.
    if (map.has(row.lead_id)) continue;
    map.set(row.lead_id, {
      lead_id: row.lead_id,
      occurred_at: row.occurred_at,
      event_type: row.event_type,
      snippet_text: row.snippet_text,
      subject: row.subject,
      intent: row.intent,
      ...readInboundMetadata(row.metadata_json),
    });
  }
  return map;
}

/**
 * The same bulk fetch for the rep's OWN latest message per lead — what a
 * follow-up card is actually about.
 *
 * Deliberately a near-copy of `fetchLatestInbounds` rather than one
 * parameterised query: `src/test/queueInboundClassification.test.ts` (Unit G-A)
 * pins the literal `.in("event_type", INBOUND_EVENT_TYPES as string[])` line as
 * its guard that the inbound read stays cross-channel, and folding the two into
 * a helper would delete the string that guard reads. Same 500-row cap and same
 * first-per-lead reduction; the AI-signal fields come back null because
 * classify-inbound only annotates inbound rows.
 */
export async function fetchLatestOutbounds(
  leads: Array<{ id: string; anchorAt?: string | null }>,
): Promise<Map<string, QueueLatestMessage>> {
  const leadIds = leads.map((l) => l.id);
  if (leadIds.length === 0) return new Map();
  // Leads whose card is scheduled from a SPECIFIC outbound (today: the nurture
  // clock) want that row, not the newest one. Everything else wants the newest,
  // which is the same thing for a `last_outbound_at`-anchored card.
  const anchors = new Map<string, number>();
  for (const l of leads) {
    const t = l.anchorAt ? new Date(l.anchorAt).getTime() : NaN;
    if (Number.isFinite(t)) anchors.set(l.id, t);
  }

  const { data, error } = await supabase
    .from("lead_timeline_items")
    .select("lead_id, occurred_at, event_type, direction, snippet_text, subject, metadata_json, intent")
    .in("lead_id", leadIds)
    .in("event_type", OUTBOUND_PREVIEW_EVENT_TYPES as string[])
    .order("occurred_at", { ascending: false })
    .limit(500);

  if (error) {
    console.warn("[queueQueries] latest outbound fetch failed:", error.message);
    return new Map();
  }

  const map = new Map<string, QueueLatestMessage>();
  for (const row of (data ?? []) as Array<{
    lead_id: string;
    occurred_at: string;
    event_type: string;
    direction: string | null;
    snippet_text: string | null;
    subject: string | null;
    metadata_json: Record<string, unknown> | null;
    intent: string | null;
  }>) {
    // An INBOUND call is projected with the same `call_completed` event type.
    // Taking one of those as "your last outbound" would be the same lie in the
    // other direction. The three written types are outbound by their own name.
    if (isOutboundCall(row) && row.direction !== "outbound") continue;
    if (map.has(row.lead_id)) continue;
    const anchor = anchors.get(row.lead_id);
    if (anchor !== undefined) {
      // Anchored lead: rows arrive newest-first, so skip past anything newer
      // than the scheduling event and take only the row AT it. If the anchored
      // row never appears (purged, or outside the window), the lead gets no
      // entry and the card shows no body — which is the point.
      const t = new Date(row.occurred_at).getTime();
      if (!Number.isFinite(t) || Math.abs(t - anchor) > ANCHOR_MATCH_SKEW_MS) continue;
    }
    const duration = (row.metadata_json ?? {}).duration_sec;
    map.set(row.lead_id, {
      lead_id: row.lead_id,
      occurred_at: row.occurred_at,
      event_type: row.event_type,
      snippet_text: row.snippet_text,
      subject: row.subject,
      intent: row.intent,
      duration_sec: typeof duration === "number" && Number.isFinite(duration) ? duration : null,
      ...readInboundMetadata(row.metadata_json),
    });
  }
  return map;
}

/**
 * The meeting a recap card is actually about — resolved through the OUTSTANDING
 * meeting pack, not by taking the newest meeting row.
 *
 * `gmail-sync` sets `hasMeetingWithoutFollowup` by walking EVERY pack on the
 * lead, so the pack that caused the card is the one still missing a
 * `follow_up_email_body` — which may be an older meeting than the most recent
 * one. Ordering meeting rows newest-first therefore showed the rep the meeting
 * they had already written up, while telling them to write it up.
 *
 * `meeting_packs.source_meeting_summary_id` is the FK to `meeting_summaries`,
 * which is the `source_id` of the timeline row `process-zoom-summary` projects —
 * so the correlation is exact where it exists at all.
 *
 * Deliberately conservative, per this unit's rule: a lead with TWO outstanding
 * packs has no identifiable triggering meeting (either could be the one the rep
 * means), and a pack with no `source_meeting_summary_id` has no row to point at.
 * Both cases return nothing and the card renders no context. A plausible guess
 * is worse than a blank.
 */
export async function fetchRecapMeetings(
  leadIds: string[],
): Promise<Map<string, QueueLatestMessage>> {
  if (leadIds.length === 0) return new Map();

  const { data: packs, error: packErr } = await supabase
    .from("meeting_packs")
    .select("lead_id, follow_up_email_body, source_meeting_summary_id")
    .in("lead_id", leadIds);

  if (packErr) {
    console.warn("[queueQueries] meeting pack fetch failed:", packErr.message);
    return new Map();
  }

  // lead → the single outstanding pack's summary id, or null once ambiguous.
  const summaryIdByLead = new Map<string, string | null>();
  for (const p of (packs ?? []) as Array<{
    lead_id: string;
    follow_up_email_body: string | null;
    source_meeting_summary_id: string | null;
  }>) {
    if ((p.follow_up_email_body ?? "").trim() !== "") continue; // already written up
    summaryIdByLead.set(
      p.lead_id,
      summaryIdByLead.has(p.lead_id) ? null : p.source_meeting_summary_id,
    );
  }

  const wanted = new Map<string, string>();
  for (const [leadId, summaryId] of summaryIdByLead) {
    if (summaryId) wanted.set(summaryId, leadId);
  }
  if (wanted.size === 0) return new Map();

  const { data, error } = await supabase
    .from("lead_timeline_items")
    .select("lead_id, occurred_at, event_type, snippet_text, subject, metadata_json, intent, source_id")
    .in("lead_id", leadIds)
    .eq("event_type", MEETING_EVENT_TYPE)
    .in("source_id", [...wanted.keys()])
    .limit(500);

  if (error) {
    console.warn("[queueQueries] recap meeting fetch failed:", error.message);
    return new Map();
  }

  const map = new Map<string, QueueLatestMessage>();
  for (const row of (data ?? []) as Array<{
    lead_id: string;
    occurred_at: string;
    event_type: string;
    snippet_text: string | null;
    subject: string | null;
    metadata_json: Record<string, unknown> | null;
    intent: string | null;
    source_id: string | null;
  }>) {
    // Only the row the outstanding pack points at, and only for that pack's lead.
    if (!row.source_id || wanted.get(row.source_id) !== row.lead_id) continue;
    if (map.has(row.lead_id)) continue;
    map.set(row.lead_id, {
      lead_id: row.lead_id,
      occurred_at: row.occurred_at,
      event_type: row.event_type,
      snippet_text: row.snippet_text,
      subject: row.subject,
      intent: row.intent,
      ...readInboundMetadata(row.metadata_json),
    });
  }
  return map;
}

// ── Orphaned outbound sends (timeline projection failed) ──────────

/**
 * How far behind `leads.last_outbound_at` a preview row may sit before we treat
 * it as the WRONG message. The two timestamps are written by different
 * statements in the same send, so a second of skew is normal; minutes are not.
 */
const OUTBOUND_PREVIEW_SKEW_MS = 60_000;

/**
 * Is this lead's newest preview row older than the send the card is dated from?
 *
 * The senders treat a failed `lead_timeline_items` projection as non-fatal and
 * carry on: `gmail-send` logs the projection error and still writes
 * `last_outbound_at`, and the `interactions` row is written either way. A
 * timeline-only preview therefore quotes the PREVIOUS message while the why-now
 * line is dated from the new one — every word confident and the pairing wrong,
 * which is the exact failure this unit exists to remove.
 *
 * Pure, so the rule can be checked without a database.
 */
export function needsOrphanBackfill(
  lead: { last_outbound_at: string | null },
  previewOccurredAt: string | null | undefined,
): boolean {
  if (!lead.last_outbound_at) return false;
  const sent = new Date(lead.last_outbound_at).getTime();
  if (!Number.isFinite(sent)) return false;
  if (!previewOccurredAt) return true; // dated from a send with nothing to show
  const preview = new Date(previewOccurredAt).getTime();
  if (!Number.isFinite(preview)) return true;
  return sent - preview > OUTBOUND_PREVIEW_SKEW_MS;
}

/**
 * `fetchLatestOutbounds` plus a repair pass for leads whose newest send never
 * made it into the timeline.
 *
 * The repair REUSES `getLeadEmailThread` (src/lib/supabaseQueries.ts), which
 * already reads the timeline and merges orphaned `interactions` rows with a
 * dedupe strategy shared with `getLeadActivityFeed`. Writing a bulk merge here
 * would be a second implementation of that strategy, free to drift from it; a
 * per-lead call to the existing one cannot. It runs ONLY for the leads the pure
 * check above flags, which is the rare projection-failure case, so the common
 * page costs exactly the one bulk query it did before.
 *
 * ponytail: one extra round-trip per affected lead. Ceiling: a workspace where
 * projection is failing wholesale would make this N+1 across a 25-row page.
 * Upgrade path: a bulk `get_latest_outbound_for_leads` RPC that does the merge
 * server-side — the same shape as `get_latest_intents_for_leads`.
 */
export async function fetchLatestOutboundsWithOrphans(
  leads: Array<{ id: string; last_outbound_at: string | null; anchorAt?: string | null }>,
): Promise<Map<string, QueueLatestMessage>> {
  const map = await fetchLatestOutbounds(
    leads.map((l) => ({ id: l.id, anchorAt: l.anchorAt })),
  );

  // Two ways a preview can be missing, and both are repairable because the
  // ANCHOR is what makes looking safe:
  //   • un-anchored ("newest outbound"): the newest send never reached the
  //     timeline — `needsOrphanBackfill` spots the date/preview mismatch.
  //   • anchored (today: a nurture send): the row AT the anchor is absent. An
  //     earlier revision excluded these outright, to stop the repair handing the
  //     card the very row the anchor exists to exclude. That was the right
  //     instinct and the wrong scope: the recovery below only ever accepts an
  //     interaction AT the anchor timestamp, so it cannot return the unrelated
  //     newer touch. Excluding them merely lost the preview permanently for a
  //     nurture email whose projection failed, while the interaction sat there
  //     matching the anchor exactly.
  const stale = leads.filter((l) =>
    l.anchorAt ? !map.has(l.id) : needsOrphanBackfill(l, map.get(l.id)?.occurred_at),
  );
  if (stale.length === 0) return map;

  await Promise.all(
    stale.map(async (l) => {
      try {
        const { emails } = await getLeadEmailThread(l.id, 10);
        const outbound = emails.filter((e) => e.direction === "outbound");
        const anchorMs = l.anchorAt ? new Date(l.anchorAt).getTime() : NaN;
        const newest = Number.isFinite(anchorMs)
          // Anchored: the send the card was scheduled FROM, or nothing. Never
          // "the newest", which is what the anchor exists to rule out.
          ? outbound.find(
              (e) => Math.abs(new Date(e.occurred_at).getTime() - anchorMs) <= ANCHOR_MATCH_SKEW_MS,
            )
          : outbound.sort(
              (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
            )[0];
        if (!newest) return;
        // Only replace when the recovered row really is newer than what the
        // timeline gave us — never downgrade a good preview. (An anchored lead
        // reaches here only with no entry at all, so this is a no-op for it.)
        const have = map.get(l.id);
        if (have && new Date(newest.occurred_at).getTime() <= new Date(have.occurred_at).getTime()) return;
        map.set(l.id, {
          lead_id: l.id,
          occurred_at: newest.occurred_at,
          event_type: "email_outbound",
          // `interactions.body_text` purges unconditionally at 72h for outbound
          // rows, so this is often empty — `cleanBodyText` then falls through to
          // the subject, exactly as it does for a purged timeline row. An empty
          // quote under a confident caption is the thing to avoid, and both
          // fields being empty leaves the card's existing no-preview path.
          snippet_text: newest.body_text?.trim() ? newest.body_text : null,
          subject: newest.subject,
          intent: null,
          ai_summary: newest.ai_summary ?? null,
          reply_worthy: null,
          urgency: null,
          tone: null,
          questions_extracted: [],
          language: null,
          sender_is_lead: null,
          duration_sec: null,
        });
      } catch (err) {
        // Best-effort repair: the card still renders from the timeline row.
        console.warn(`[queueQueries] orphan outbound backfill failed for ${l.id}:`, err);
      }
    }),
  );
  return map;
}

/**
 * Read the fields `classify-inbound` persists into `metadata_json`.
 *
 * This function used to ignore `metadata_json` entirely apart from
 * `ai_summary`, so the four AI signals the product pays for on every
 * inbound (reply_worthy, urgency, tone, questions_extracted) never
 * reached the card and it fell back to "[No preview available]" more
 * often than it needed to. Every field is optional and independently
 * defensive: bad or missing JSON yields nulls, never a throw.
 */
export function readInboundMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Pick<
  QueueLatestInbound,
  | "ai_summary"
  | "reply_worthy"
  | "urgency"
  | "tone"
  | "questions_extracted"
  | "language"
  | "sender_is_lead"
> {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const signals = (meta.ai_signals ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

  return {
    ai_summary: str(meta.ai_summary),
    reply_worthy: bool(signals.reply_worthy),
    urgency: str(signals.urgency),
    tone: str(signals.tone),
    questions_extracted: Array.isArray(signals.questions_extracted)
      ? (signals.questions_extracted as unknown[]).filter(
          (q): q is string => typeof q === "string" && q.trim().length > 0,
        )
      : [],
    language: str(signals.language),
    sender_is_lead: bool(meta.sender_is_lead),
  };
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
  total: number;
}

export function countChipBuckets(leads: QueueLeadRow[]): QueueChipCounts {
  let replied = 0;
  let followup_due = 0;
  for (const l of leads) {
    const bucket = chipForLead({
      next_action_key: l.next_action_key,
      action_resurfaced_at: l.action_resurfaced_at,
    });
    if (bucket === "replied") replied += 1;
    else if (bucket === "followup_due") followup_due += 1;
  }
  return { replied, followup_due, total: leads.length };
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
 * Mapping mirrors `chipForLead`: only "replied" is customer-waiting;
 * everything else (including back-from-away leads, which bucket into
 * "followup_due") is rep-waiting → "Follow up". Single source of truth
 * means button label and chip always agree.
 */
export function queueButtonLabel(input: {
  next_action_key: string | null;
  action_resurfaced_at: string | null;
}): QueueButtonLabel {
  const bucket = chipForLead(input);
  if (bucket === "replied") return "Reply";
  return "Follow up";
}

// ── What is this card actually about? (labels + which message) ────
//
// The Follow-up tab covers a dozen different `next_action_key`s and, before
// Unit Q2, every one of them rendered the identical word "Follow up" over the
// customer's latest INBOUND message. Two separate lies in one card: the rep
// couldn't tell "they went quiet after your third email" from "your proposal
// needs chasing" from "we couldn't send this — you're over your sending limit",
// and the message quoted underneath was never the one the card was about.
//
// One pure table, so the labels can be checked against a table of inputs
// instead of being read out of JSX. QueueCard renders what this returns and
// decides nothing itself.

export type QueueBodySource = "inbound" | "outbound" | "meeting";

/**
 * WHICH CLOCK SCHEDULED THIS CARD.
 *
 * The single rule this unit kept re-discovering, stated once: a card must quote
 * the event that caused it, and `deriveAction` does not always schedule off the
 * newest thing that happened. `send_nurture_N` is scheduled from
 * `last_nurture_outbound_at`, so a manual call or an unrelated email sent since
 * must not be quoted or dated. `generate_post_meeting_recap` is scheduled from a
 * meeting pack, not from a timestamp on the lead at all.
 *
 * A new key inherits the rule by naming its anchor here; the preview then
 * follows automatically, and where the anchored row cannot be found the card
 * shows no body rather than a plausible-looking neighbour.
 */
export type QueueAnchorField =
  | "last_inbound_at"
  | "last_outbound_at"
  | "last_nurture_outbound_at"
  /** Not a column: correlated through the outstanding meeting pack. */
  | "meeting_pack"
  /** Nothing to correlate to — the card carries no quoted body. */
  | null;

export interface QueueSituation {
  /** Plain English, what a rep would say out loud. No enum names, no jargon. */
  label: string;
  /** Optional second clause (a date, a cap) — null when the label says it all. */
  detail: string | null;
  /** Whose message the card body must quote: theirs, or my unanswered one. */
  bodySource: QueueBodySource;
  /**
   * Whether a "sent 6 days ago" / "2 hours ago" phrase belongs on the why-now
   * line. False for back-from-away: the timestamp there predates the absence
   * and reads as though the rep has been ignoring the lead for a fortnight.
   */
  showTime: boolean;
  /** The clock that scheduled this card — see QueueAnchorField. */
  anchorField: QueueAnchorField;
}

/** Everything on the rep's own side of the conversation shares this shape. */
const MINE = (label: string, detail: string | null = null): QueueSituation => ({
  label,
  detail,
  bodySource: "outbound",
  showTime: true,
  anchorField: "last_outbound_at",
});

/**
 * Fixed situations, keyed by `next_action_key`. `send_nurture_N` is handled
 * below because N is open-ended. Every key in `QUEUE_ACTION_KEYS`
 * (`@shared/followupRule`) has an entry — `src/test/queueCardLabels.test.ts`
 * fails if a new key is added upstream without a label here.
 */
const SITUATIONS: Record<string, QueueSituation> = {
  reply_now: {
    label: "They replied",
    detail: null,
    bodySource: "inbound",
    showTime: true,
    anchorField: "last_inbound_at",
  },
  ooo_return_followup: {
    label: "They were away — they're back now",
    detail: null,
    bodySource: "outbound",
    showTime: false,
    anchorField: "last_outbound_at",
  },
  // "email" would be a lie on a cross-channel trigger: `leads.last_outbound_at`
  // is stamped by sms-send and the WhatsApp path too (executionSettings.ts), and
  // fetchLatestOutbounds duly returns the sms_outbound row. "message" is always
  // true and costs nothing.
  followup_due: MINE("No reply to your last message"),
  // The card that used to say "Follow up" while nothing had in fact been sent.
  //
  // Three things this wording has to get right, all of them previously wrong:
  //   • the cap is PER LEAD (`max_emails_per_lead_per_7d` / `_30d` are the only
  //     paths into `rateLimitedAction`, syncEngine.ts). "Your sending limit"
  //     told the rep their whole account was throttled and would stop them
  //     emailing everyone else too.
  //   • `followupRule.ts` states the contract: the cap pauses the AUTOMATIC
  //     send, the rep can still write to this lead right now — and the label
  //     must not read as "you may not act until <date>". So it says so.
  //   • no time phrase (`showTime: false`): the composed line otherwise read
  //     "Not sent … · sent 3 hours ago", contradicting itself mid-sentence.
  rate_limited: {
    label: "Too many emails to this lead recently — nothing was sent; you can still write to them",
    detail: null,
    bodySource: "outbound",
    showTime: false,
    anchorField: "last_outbound_at",
  },
  closing_followup: MINE("Your proposal needs chasing"),
  // No time phrase, and no OUTBOUND body: this fires on
  // `hasMeetingWithoutFollowup`, so there IS no outbound after the meeting and
  // `last_outbound_at` is some pre-meeting email. Dating the card off it read as
  // the meeting's age (fixed earlier); quoting it put a three-week-old
  // scheduling email under "Your message" beneath "Send them the recap from your
  // meeting" — the same defect, one field over. The card shows the MEETING, or
  // nothing at all.
  generate_post_meeting_recap: {
    label: "Send them the recap from your meeting",
    detail: null,
    bodySource: "meeting",
    showTime: false,
    anchorField: "meeting_pack",
  },
  post_meeting_followup: MINE("No word since your meeting"),
  send_pre_2: MINE("Intro sequence — second email is due"),
  send_pre_3: MINE("Intro sequence — third email is due"),
  // syncEngine labels this "Send breakup email" in both places it can emit it.
  // Which email it is changes what the rep writes, so the label says it.
  send_pre_4: MINE("Breakup email is due — the last one before you let this go"),
  reengage: MINE("Gone quiet — worth re-opening"),
  // NOT a status update. syncEngine writes `auto_nurture_eligible: true` and
  // that flag is read-only — dashboardUtils / dashboardMetricsService display
  // it, motionUpdater only CLEARS it when a rep changes motion by hand. Nothing
  // switches the motion. A present-progressive label ("Moving them to…") reads
  // as something already happening, so the one card that needs a human decision
  // is the one the rep scrolls past. It asks.
  switch_to_nurture: MINE("Three emails, no reply — switch them to the slow track?"),
};

/**
 * The moment that scheduled this card, read off the lead through the
 * situation's anchor. Null when there is nothing on the lead to anchor to
 * (`meeting_pack`, or a situation with no anchor at all).
 */
export function anchorTimestamp(
  lead: Pick<QueueLeadRow, "last_inbound_at" | "last_outbound_at" | "last_nurture_outbound_at">,
  situation: Pick<QueueSituation, "anchorField">,
): string | null {
  switch (situation.anchorField) {
    case "last_inbound_at": return lead.last_inbound_at;
    case "last_outbound_at": return lead.last_outbound_at;
    case "last_nurture_outbound_at": return lead.last_nurture_outbound_at;
    default: return null;
  }
}

/** Two timestamps written by different statements in one send. */
const ANCHOR_MATCH_SKEW_MS = 60_000;

/**
 * Is this preview row the event the card was scheduled from?
 *
 * The card may quote a row ONLY if it can establish the correlation. A
 * `meeting_pack` anchor is correlated upstream (the fetch resolves the
 * outstanding pack's summary id, so any row it returns is by definition the
 * right one); a column anchor is checked here against the row's own timestamp.
 * Anything else renders no body — "I can't tell which one" must never render as
 * a plausible guess.
 */
export function previewMatchesAnchor(
  lead: Pick<QueueLeadRow, "last_inbound_at" | "last_outbound_at" | "last_nurture_outbound_at">,
  situation: Pick<QueueSituation, "anchorField">,
  message: { occurred_at: string } | null | undefined,
): boolean {
  if (!message) return false;
  if (situation.anchorField === "meeting_pack") return true;
  const anchor = anchorTimestamp(lead, situation);
  if (!anchor) return false;
  const a = new Date(anchor).getTime();
  const m = new Date(message.occurred_at).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(m)) return false;
  return Math.abs(a - m) <= ANCHOR_MATCH_SKEW_MS;
}

/**
 * Which outbound row the preview fetch should bring back for this lead: a
 * specific timestamp when the card is scheduled off its own clock, or null for
 * "the newest", which is what a `last_outbound_at`-anchored card wants anyway.
 *
 * General by construction — a future outbound key that names a different anchor
 * inherits this without touching the fetch.
 */
export function outboundAnchorFor(lead: QueueLeadRow): string | null {
  const situation = describeQueueSituation({
    next_action_key: lead.next_action_key,
    next_action_label: lead.next_action_label,
  });
  if (situation.bodySource !== "outbound") return null;
  if (situation.anchorField === "last_outbound_at" || situation.anchorField === null) return null;
  return anchorTimestamp(lead, situation);
}

/**
 * Pull the useful tail off a server-written `next_action_label`.
 *
 * `rateLimitedAction` writes "Follow up anytime — auto-send paused until Sep 12".
 * The head is the generic instruction our own label already replaces; the tail
 * is the one fact the rep can't get anywhere else (when the cap lifts), and it
 * is rendered in the WORKSPACE's timezone by the writer, so we pass it through
 * verbatim rather than re-deriving a date here.
 */
function labelTail(next_action_label: string | null | undefined): string | null {
  const parts = (next_action_label ?? "").split(" — ");
  const tail = (parts.length > 1 ? parts[parts.length - 1] : "").trim();
  return tail.length > 0 ? tail : null;
}

/**
 * What is this card about, in words a salesperson would use, and whose message
 * belongs under it. Pure — no DB, no clock, no React.
 */
export function describeQueueSituation(
  lead: { next_action_key: string | null; next_action_label: string | null },
  opts: {
    /** The rep's newest outbound touch is a completed phone call, not a message. */
    latestOutboundIsCall?: boolean;
  } = {},
): QueueSituation {
  const key = lead.next_action_key ?? "";

  // `followup_due` fires on "my last touch, unanswered for N days" and
  // `last_outbound_at` is stamped by the voice webhook too, so that touch may be
  // a call. "No reply to your last message" over a call recording is the same
  // class of wrong that "email" was over an SMS. Only this key is adjusted: the
  // others are about a proposal or a meeting, not about the medium.
  if (key === FOLLOWUP_DUE_KEY && opts.latestOutboundIsCall) {
    return MINE("Nothing back since your call");
  }

  if (key === "rate_limited") {
    // The tail is the server's own "auto-send paused until <date>", rendered in
    // the WORKSPACE's timezone by `formatAvailableDate`. Passed through verbatim
    // — never re-derived here, where the browser's zone would be wrong.
    return { ...SITUATIONS.rate_limited, detail: labelTail(lead.next_action_label) };
  }

  const fixed = SITUATIONS[key];
  if (fixed) return fixed;

  // send_nurture_1 … send_nurture_8 — one line, not eight table rows.
  // Anchored to the NURTURE clock, not to `last_outbound_at`: syncEngine
  // schedules this from `metrics.last_nurture_outbound_at`, so a manual call or
  // an unrelated email sent since is neither what the card is about nor what
  // dates it — and quoting it put "email 3 is due · sent 2 days ago" over
  // yesterday's SMS about something else.
  const nurture = /^send_nurture_(\d+)$/.exec(key);
  if (nurture) {
    return {
      ...MINE(`Nurture sequence — email ${nurture[1]} is due`),
      anchorField: "last_nurture_outbound_at",
    };
  }

  // Unknown key (a new one upstream, or a null). Prefer whatever the server
  // wrote over inventing a label; "Needs a look" beats a raw enum name.
  return MINE(lead.next_action_label?.trim() || "Needs a look");
}

// ── Full message body (reply bridge) ──────────────────────────────
//
// Queue cards render a 500-char snippet (or the AI summary). Reps often need
// the whole email before replying, so this fetches the full stored body of the
// lead's most recent message in the given direction. `interactions.body_text`
// keeps the full text for 30 days (message-cleanup purges it after that, gated
// on the classifier having written a durable ai_summary) — past that we return
// null and the card keeps showing the summary.
//
// The direction argument is Unit Q2: a follow-up card quotes the rep's own
// unanswered email, so "Show full email" there has to open THAT message, not
// the customer's last inbound.
export async function fetchLatestMessageBody(
  leadId: string,
  direction: "inbound" | "outbound" = "inbound",
): Promise<string | null> {
  const { data, error } = await supabase
    .from("interactions")
    .select("body_text, occurred_at")
    .eq("lead_id", leadId)
    .eq("direction", direction)
    .not("body_text", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message || "Couldn't load the full email");
  const body = (data?.[0]?.body_text ?? "").trim();
  return body.length > 0 ? body : null;
}
