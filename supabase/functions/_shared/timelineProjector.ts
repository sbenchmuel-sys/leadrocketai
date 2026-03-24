// ============================================================
// Timeline Projector — Idempotent writer for lead_timeline_items
// ============================================================

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface TimelineItemInput {
  workspace_id: string;
  lead_id: string;
  contact_id?: string | null;
  conversation_id?: string | null;
  channel: string;           // email, whatsapp, voice, meeting, system
  provider?: string | null;  // gmail, outlook, meta, twilio, zoom, manual
  direction?: string | null; // inbound, outbound
  event_type: string;        // email_inbound, whatsapp_outbound, phone_call, meeting, note, system_note
  occurred_at: string;       // ISO-8601
  source_table: string;      // interactions, call_sessions, meeting_summaries, messages
  source_id: string;         // UUID from source table
  snippet_text?: string | null;
  subject?: string | null;
  status_json?: Record<string, unknown>;
  metadata_json?: Record<string, unknown>;
  dedupe_key: string;        // Must be unique per lead
}

/**
 * Upsert a timeline item idempotently.
 * Uses ON CONFLICT (lead_id, dedupe_key) DO UPDATE for safe re-runs.
 */
export async function projectTimelineItem(
  supabase: SupabaseClient,
  item: TimelineItemInput,
): Promise<void> {
  const row = {
    workspace_id: item.workspace_id,
    lead_id: item.lead_id,
    contact_id: item.contact_id ?? null,
    conversation_id: item.conversation_id ?? null,
    channel: item.channel,
    provider: item.provider ?? null,
    direction: item.direction ?? null,
    event_type: item.event_type,
    occurred_at: item.occurred_at,
    source_table: item.source_table,
    source_id: item.source_id,
    snippet_text: item.snippet_text ? item.snippet_text.substring(0, 500) : null,
    subject: item.subject ?? null,
    status_json: item.status_json ?? {},
    metadata_json: item.metadata_json ?? {},
    dedupe_key: item.dedupe_key,
  };

  const { error } = await supabase
    .from("lead_timeline_items")
    .upsert(row, { onConflict: "lead_id,dedupe_key" });

  if (error) {
    console.warn("[timelineProjector] Upsert failed:", error.message, { dedupe_key: item.dedupe_key });
  }
}

/**
 * Build a standard dedupe key for email events (Gmail/Outlook).
 * Uses provider message ID when available for idempotency.
 */
export function emailDedupeKey(provider: string, messageId: string | null, interactionId: string): string {
  if (messageId) return `${provider}:${messageId}`;
  return `${provider}:interaction:${interactionId}`;
}

/**
 * Build a standard dedupe key for WhatsApp events.
 */
export function whatsappDedupeKey(direction: string, providerMessageId: string | null, fallbackId: string): string {
  if (providerMessageId) return `wa:${direction}:${providerMessageId}`;
  return `wa:${direction}:${fallbackId}`;
}

/**
 * Build a standard dedupe key for call events.
 */
export function callDedupeKey(callSessionId: string): string {
  return `call:${callSessionId}`;
}

/**
 * Build a standard dedupe key for meeting events.
 */
export function meetingDedupeKey(meetingSummaryId: string): string {
  return `meeting:${meetingSummaryId}`;
}
