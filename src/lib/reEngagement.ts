// ============================================================
// Re-engagement eligibility — UI gate for the "Draft re-engagement"
// button. This is a conservative subset of the conditions under
// which `playbookResolver` (src/lib/playbookResolver.ts) would
// return `recommended_intent: "re_engagement_intro"`.
//
// We deliberately do NOT re-implement routing. The full resolver
// still runs inside `streamDraft`; this predicate exists only to
// gate visibility cheaply from the lead row + queue row without
// loading the full ResolvedContext. False negatives are fine
// (button just doesn't appear); false positives would let a rep
// re-engage a lead whose reply is actually the newest message,
// which the brief forbids — so we keep the guard tight.
// ============================================================

import type { MilestoneItem } from "@/lib/supabaseQueries";

export interface ReEngagementGateInput {
  motion: string | null;
  source_type?: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  next_action_key: string | null;
  has_future_meeting?: boolean | null;
  stage?: string | null;
}

// Source types that `playbookResolver.isInboundLeadContext` treats
// as inbound. Kept in sync with that list.
const INBOUND_SOURCE_TYPES = new Set([
  "contact_form",
  "gmail_inbound",
  "referral",
  "whatsapp_inbound",
]);

// next_action_keys that `playbookResolver.mapActionKeyToIntent`
// routes to a different intent — when any of these are set, the
// resolver returns something other than re_engagement_intro and
// our button must stay hidden.
const PRE_EMPTING_ACTION_KEY_RE =
  /^(send_pre_|send_nurture_|generate_post_meeting_recap|post_meeting_followup|send_proposal|closing_followup|reply_now)/;

export function isReEngagementCandidate(input: ReEngagementGateInput): boolean {
  const { motion, source_type, last_outbound_at, last_inbound_at, next_action_key, has_future_meeting, stage } = input;

  // Must be a warm / inbound-sourced lead.
  const inboundContext =
    motion === "inbound_response" ||
    (!!source_type && INBOUND_SOURCE_TYPES.has(source_type));
  if (!inboundContext) return false;

  // Must have an actual thread (both directions present).
  if (!last_outbound_at || !last_inbound_at) return false;

  // Hard guard the brief calls out: never show when their reply is
  // the newest message in the thread.
  if (new Date(last_inbound_at).getTime() >= new Date(last_outbound_at).getTime()) return false;

  // Skip motions/states that route elsewhere.
  if (motion === "nurture" || motion === "closing") return false;
  if (motion === "post_meeting" || stage === "post_meeting") return false;
  if (has_future_meeting) return false;

  // Skip when an action key would pre-empt the default branch.
  if (next_action_key && PRE_EMPTING_ACTION_KEY_RE.test(next_action_key)) return false;

  return true;
}

// ------------------------------------------------------------
// Plain-English summary line for "what this draft is built on".
// Sources: lead.milestones_json (pending items) +
// deal_memory.unanswered_questions. No new scoring/routing logic.
// ------------------------------------------------------------

export interface ReEngagementSummaryInput {
  milestones: MilestoneItem[] | null | undefined;
  unanswered_questions: string[] | null | undefined;
}

function trimItem(s: string, max = 60): string {
  const clean = s.replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

export function buildReEngagementSummaryLine(input: ReEngagementSummaryInput): string {
  const pendingMilestones = (input.milestones || [])
    .filter((m) => m && m.status === "pending" && m.description)
    .map((m) => trimItem(m.description));
  const questions = (input.unanswered_questions || [])
    .filter((q): q is string => !!q && q.trim().length > 0)
    .map((q) => trimItem(q));

  // List up to 3 open items plainly. Order: questions first (they're what
  // they last asked), then pending milestones (what we owe them).
  const items: string[] = [];
  for (const q of questions) {
    if (!items.includes(q)) items.push(q);
    if (items.length >= 3) break;
  }
  for (const m of pendingMilestones) {
    if (items.length >= 3) break;
    if (!items.includes(m)) items.push(m);
  }

  if (items.length === 0) {
    return "Picking up where the thread left off.";
  }
  return `Picking up where you left off: ${items.join(", ")}`;
}
