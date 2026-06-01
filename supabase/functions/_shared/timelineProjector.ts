// ============================================================
// Timeline Projector — Idempotent writer for lead_timeline_items
// + async recompute trigger
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
 * Optionally queues an async intelligence recompute.
 */
export async function projectTimelineItem(
  supabase: SupabaseClient,
  item: TimelineItemInput,
  options?: { triggerRecompute?: boolean },
): Promise<void> {
  const incomingMetadata = Object.fromEntries(
    Object.entries(item.metadata_json ?? {}).filter(([, value]) => value !== undefined),
  );

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
    metadata_json: incomingMetadata,
    dedupe_key: item.dedupe_key,
  };

  const { data: existing } = await supabase
    .from("lead_timeline_items")
    .select("id, snippet_text, metadata_json")
    .eq("lead_id", item.lead_id)
    .eq("dedupe_key", item.dedupe_key)
    .maybeSingle();

  if (existing?.id) {
    const needsSnippetRefill = item.snippet_text && item.snippet_text.trim().length > 0
      && (!existing.snippet_text || String(existing.snippet_text).trim() === "");
    const mergedMetadata = {
      ...((existing.metadata_json as Record<string, unknown> | null) ?? {}),
      ...incomingMetadata,
    };

    if (needsSnippetRefill || Object.keys(incomingMetadata).length > 0) {
      const { error: updateError } = await supabase
        .from("lead_timeline_items")
        .update({
          ...(needsSnippetRefill ? { snippet_text: item.snippet_text!.substring(0, 500) } : {}),
          metadata_json: mergedMetadata,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);

      if (updateError) {
        console.warn("[timelineProjector] Existing-row update failed:", updateError.message, { dedupe_key: item.dedupe_key });
      }
    }

    return;
  }

  const { error } = await supabase
    .from("lead_timeline_items")
    .upsert(row, { onConflict: "lead_id,dedupe_key" });

  if (error) {
    console.warn("[timelineProjector] Upsert failed:", error.message, { dedupe_key: item.dedupe_key });
    return;
  }

  if (item.snippet_text && item.snippet_text.trim().length > 0) {
    const { error: refillError } = await supabase
      .from("lead_timeline_items")
      .update({
        snippet_text: item.snippet_text.substring(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("lead_id", item.lead_id)
      .eq("dedupe_key", item.dedupe_key)
      .or("snippet_text.is.null,snippet_text.eq.");

    if (refillError) {
      console.warn("[timelineProjector] Snippet refill failed:", refillError.message, { dedupe_key: item.dedupe_key });
    }
  }

  // Fire-and-forget recompute if requested
  if (options?.triggerRecompute && item.lead_id) {
    queueRecompute(supabase, item.lead_id).catch((err) => {
      console.warn("[timelineProjector] Recompute queue failed:", err.message);
    });
  }
}

/**
 * Queue an async intelligence recompute for a lead.
 * Uses internal secret header to bypass user auth.
 * Fire-and-forget — failures are logged but don't block the caller.
 */
export async function queueRecompute(
  _supabase: SupabaseClient,
  leadId: string,
): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");

  if (!supabaseUrl || !internalSecret) {
    console.warn("[timelineProjector] Cannot queue recompute: missing env vars");
    return;
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/recompute-lead-intelligence`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
      },
      body: JSON.stringify({ lead_id: leadId }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`[timelineProjector] Recompute returned ${res.status}: ${body.substring(0, 200)}`);
    } else {
      // Consume body to free connection
      await res.text();
      console.log(`[timelineProjector] Recompute queued for lead ${leadId}`);
    }
  } catch (err: any) {
    console.warn("[timelineProjector] Recompute fetch error:", err.message);
  }
}

/**
 * Build a standard dedupe key for email events (Gmail/Outlook).
 * Uses provider message ID when available for idempotency.
 *
 * IMPORTANT: The dedupe key must be stable across sync paths.
 * Gmail uses its message ID; Outlook uses its internet message ID.
 * This ensures gmail-sync and gmail-bulk-sync (or outlook-sync and
 * outlook-webhook) produce the same key for the same message.
 */
export function emailDedupeKey(provider: string, messageId: string | null, interactionId: string): string {
  if (messageId) return `${provider}:${messageId}`;
  return `${provider}:interaction:${interactionId}`;
}

/**
 * Build a stable dedupe key for Outlook emails.
 * Prefers internet_message_id (RFC 2822 Message-ID) which is
 * consistent between outlook-sync and outlook-webhook.
 * Falls back to the Outlook graph message ID if unavailable.
 */
export function outlookEmailDedupeKey(internetMessageId: string | null, graphMessageId: string | null, interactionId: string): string {
  if (internetMessageId) return `outlook:${internetMessageId}`;
  if (graphMessageId) return `outlook:graph:${graphMessageId}`;
  return `outlook:interaction:${interactionId}`;
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
