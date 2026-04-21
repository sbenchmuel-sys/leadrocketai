// ============================================================
// Lead Activity Adapter
// ------------------------------------------------------------
// Single canonical READ path for lead-centric activity history.
//
// Source of truth: `lead_timeline_items` (canonical cross-channel ledger).
// Compatibility fallback: `interactions` (legacy table — still dual-written).
//
// Rules:
//   • Timeline always wins.
//   • Interactions are merged in only when no timeline row references them
//     (matched by source_id == interaction.id OR gmail_message_id).
//   • Aggressive dedupe by (id, gmail_message_id, content+ts).
//
// This adapter is intentionally narrow and read-only. It does not touch
// write paths, automation, inbox threading, or schema.
//
// TODO(cleanup): Once `interactions` is fully back-filled into
// `lead_timeline_items` (verifiable by smoke test), remove the fallback
// branch and the `getLeadInteractions` import.
// ============================================================

import { supabase } from "@/integrations/supabase/client";
import {
  getLeadTimeline,
  getLeadInteractions,
  type TimelineItem,
  type InteractionItem,
} from "@/lib/supabaseQueries";
import { isDemoMode } from "@/lib/demoMode";

export interface LeadActivityItem {
  id: string;
  lead_id: string;
  channel: string;                      // "email" | "whatsapp" | "sms" | "voice" | "meeting" | "system" | ...
  direction: "inbound" | "outbound" | null;
  event_type: string;                   // canonical event_type from timeline OR mapped from legacy
  occurred_at: string;
  subject: string | null;
  snippet_text: string | null;
  hidden: boolean;

  // Provenance — useful for callers that still need legacy linkage
  source: "timeline" | "interactions_fallback";
  source_table: string;
  source_id: string;
  gmail_message_id: string | null;

  // Optional pass-throughs
  metadata_json?: Record<string, unknown>;
}

export interface GetLeadActivityOptions {
  includeHidden?: boolean;
  channel?: string;
  limit?: number;
}

// ------------------------------------------------------------
// Internal: legacy interaction → unified shape
// ------------------------------------------------------------

function mapInteractionToActivity(i: InteractionItem): LeadActivityItem {
  const channel = i.type?.includes("email")
    ? "email"
    : i.type?.includes("whatsapp")
    ? "whatsapp"
    : i.type?.includes("sms")
    ? "sms"
    : i.type?.includes("call") || i.type?.includes("voice")
    ? "voice"
    : "system";

  const direction =
    i.type?.includes("inbound")
      ? "inbound"
      : i.type?.includes("outbound")
      ? "outbound"
      : null;

  return {
    id: i.id,
    lead_id: i.lead_id,
    channel,
    direction,
    event_type: i.type,
    occurred_at: i.occurred_at,
    subject: i.subject ?? null,
    snippet_text: i.body_text ?? null,
    hidden: i.hidden ?? false,
    source: "interactions_fallback",
    source_table: "interactions",
    source_id: i.id,
    gmail_message_id: i.gmail_message_id ?? null,
    metadata_json: {
      from_email: i.from_email,
      to_email: i.to_email,
      ai_summary: i.ai_summary,
      ai_intent: i.ai_intent,
      ai_reply_worthy: i.ai_reply_worthy,
    },
  };
}

function mapTimelineToActivity(t: TimelineItem): LeadActivityItem {
  return {
    id: t.id,
    lead_id: t.lead_id,
    channel: t.channel,
    direction: (t.direction as "inbound" | "outbound" | null) ?? null,
    event_type: t.event_type,
    occurred_at: t.occurred_at,
    subject: t.subject,
    snippet_text: t.snippet_text,
    hidden: t.hidden,
    source: "timeline",
    source_table: t.source_table,
    source_id: t.source_id,
    gmail_message_id: (t.metadata_json as any)?.gmail_message_id ?? null,
    metadata_json: t.metadata_json,
  };
}

// Build dedupe keys for a timeline item — anything that would collide with
// a legacy interactions row should resolve to the same key set.
function timelineDedupeKeys(t: TimelineItem): string[] {
  const keys: string[] = [];
  if (t.source_id) keys.push(`sid:${t.source_id}`);
  const gmailId = (t.metadata_json as any)?.gmail_message_id;
  if (gmailId) keys.push(`gmail:${gmailId}`);
  // Soft content key (channel|ts-second|first-80-chars) — last-resort match
  if (t.snippet_text) {
    const ts = new Date(t.occurred_at).toISOString().slice(0, 19);
    keys.push(`soft:${t.channel}:${ts}:${t.snippet_text.slice(0, 80)}`);
  }
  return keys;
}

function interactionDedupeKeys(i: InteractionItem): string[] {
  const keys: string[] = [`sid:${i.id}`];
  if (i.gmail_message_id) keys.push(`gmail:${i.gmail_message_id}`);
  if (i.body_text) {
    const ts = new Date(i.occurred_at).toISOString().slice(0, 19);
    const ch = i.type?.includes("email")
      ? "email"
      : i.type?.includes("whatsapp")
      ? "whatsapp"
      : i.type?.includes("sms")
      ? "sms"
      : "system";
    keys.push(`soft:${ch}:${ts}:${i.body_text.slice(0, 80)}`);
  }
  return keys;
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * Canonical lead activity feed.
 * Reads `lead_timeline_items` first, then merges any orphaned legacy
 * `interactions` rows that were never bridged.
 */
export async function getLeadActivityFeed(
  leadId: string,
  options: GetLeadActivityOptions = {}
): Promise<LeadActivityItem[]> {
  if (!leadId) throw new Error("Missing leadId");

  const limit = options.limit ?? 200;

  // Demo mode: timeline query already synthesizes from demo interactions.
  if (isDemoMode()) {
    const tl = await getLeadTimeline(leadId, options);
    return tl.map(mapTimelineToActivity);
  }

  // 1) Canonical: timeline
  const timeline = await getLeadTimeline(leadId, { ...options, limit });

  // 2) Fallback merge: legacy interactions that have no timeline mirror
  let fallbackUsed = 0;
  let fallbackItems: LeadActivityItem[] = [];
  try {
    const legacy = await getLeadInteractions(leadId, options.includeHidden ?? false);

    if (legacy.length > 0) {
      const seen = new Set<string>();
      for (const t of timeline) for (const k of timelineDedupeKeys(t)) seen.add(k);

      for (const i of legacy) {
        const keys = interactionDedupeKeys(i);
        if (keys.some((k) => seen.has(k))) continue;

        // Channel filter parity with timeline query
        const mapped = mapInteractionToActivity(i);
        if (options.channel && mapped.channel !== options.channel) continue;

        fallbackItems.push(mapped);
        for (const k of keys) seen.add(k);
        fallbackUsed += 1;
      }
    }
  } catch (err) {
    // Non-fatal — timeline is canonical; fallback is best-effort.
    console.warn("[leadActivity] legacy interactions fallback failed", err);
  }

  if (fallbackUsed > 0 && import.meta.env.DEV) {
    console.info(
      `[leadActivity] lead=${leadId} timeline=${timeline.length} ` +
        `legacy_fallback=${fallbackUsed} (orphaned interactions merged)`
    );
  }

  const merged = [...timeline.map(mapTimelineToActivity), ...fallbackItems];
  merged.sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
  );

  return merged.slice(0, limit);
}

/**
 * Convenience: did the rep send any outbound activity after the given date?
 * Used by post-meeting recap heuristics across the lead UI.
 */
export async function hasOutboundActivityAfter(
  leadId: string,
  after: Date
): Promise<boolean> {
  const feed = await getLeadActivityFeed(leadId, { limit: 50 });
  const cutoff = after.getTime();
  return feed.some(
    (a) =>
      a.direction === "outbound" &&
      !a.hidden &&
      new Date(a.occurred_at).getTime() > cutoff
  );
}
