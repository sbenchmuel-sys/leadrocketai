// ============================================================
// canonicalInteraction — Single source of truth for creating
// an interaction row + its matching lead_timeline_items entry.
//
// All sync/webhook/processor paths should use this helper
// instead of inserting into interactions + calling
// projectTimelineItem separately. This guarantees:
//   1. The timeline source_id is the interaction UUID
//   2. Exactly one timeline row per interaction
//   3. System notes are also projected into the timeline
//   4. Duplicate interactions are blocked by the DB-level
//      UNIQUE INDEX on dedupe_key (idx_interactions_dedupe_key_unique).
//   5. dedupe_key is MANDATORY — callers must provide it or
//      one is auto-generated from available fields.
// ============================================================

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { projectTimelineItem, emailDedupeKey, whatsappDedupeKey } from "./timelineProjector.ts";

export interface CanonicalInteractionInput {
  // Required
  lead_id: string;
  type: string;            // email_inbound, email_outbound, whatsapp_inbound, whatsapp_outbound, system_note, note
  source: string;          // gmail, outlook, whatsapp, automation, manual
  body_text: string;
  occurred_at: string;

  // Optional interaction fields
  direction?: "inbound" | "outbound" | null;
  subject?: string | null;
  from_email?: string | null;
  to_email?: string | null;
  gmail_message_id?: string | null;
  gmail_thread_id?: string | null;
  ai_intent?: string | null;
  ai_summary?: string | null;
  ai_reply_worthy?: boolean | null;
  hidden?: boolean;

  // Timeline projection context
  workspace_id?: string | null;
  contact_id?: string | null;
  conversation_id?: string | null;
  provider?: string | null;        // gmail, outlook, meta, twilio, zoom, manual, automation
  metadata_json?: Record<string, unknown>;
  status_json?: Record<string, unknown>;

  // Dedupe key override — if not provided, auto-generated from available fields
  dedupe_key?: string;
}

export interface CanonicalInteractionResult {
  interaction_id: string | null;
  timeline_projected: boolean;
  duplicate: boolean;
  error?: string;
}

/**
 * Derive the timeline channel from the interaction type.
 */
function deriveChannel(type: string): string {
  if (type.startsWith("email")) return "email";
  if (type.startsWith("whatsapp")) return "whatsapp";
  if (type === "phone_call") return "voice";
  if (type === "meeting") return "meeting";
  return "system";
}

/**
 * Build a deterministic dedupe key from available fields.
 *
 * IMPORTANT: The key MUST be stable across retries. Never use
 * random values or non-deterministic timestamps here.
 */
function buildDedupeKey(input: CanonicalInteractionInput): string {
  // If explicitly provided, use it
  if (input.dedupe_key) return input.dedupe_key;

  const channel = deriveChannel(input.type);

  // Email: use provider + message ID for stable cross-sync dedup
  if (channel === "email" && input.gmail_message_id) {
    return emailDedupeKey(input.source, input.gmail_message_id, input.gmail_message_id);
  }

  // WhatsApp: use direction + provider message ID
  if (channel === "whatsapp") {
    const provMsgId = (input.metadata_json?.provider_message_id as string) || null;
    return whatsappDedupeKey(input.direction || "unknown", provMsgId, `${input.lead_id}:${input.occurred_at}`);
  }

  // System notes: use source + type + lead + a stable content hash
  // to prevent duplicates on retry while allowing genuinely different notes
  const contentFingerprint = stableHash(`${input.body_text?.substring(0, 100)}|${input.subject || ""}`);
  return `${input.source}:${input.type}:${input.lead_id}:${contentFingerprint}`;
}

/**
 * FNV-1a hash for stable, deterministic fingerprinting.
 * NOT cryptographic — just for dedupe key generation.
 */
function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

// Postgres unique_violation error code
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Check if a Supabase/PostgREST error is a unique constraint violation.
 */
function isUniqueViolation(err: { code?: string; message?: string }): boolean {
  if (err.code === PG_UNIQUE_VIOLATION) return true;
  if (err.code === "PGRST116") return false; // "not found" — not a duplicate
  if (err.message && /duplicate key|unique.?constraint|unique.?violation|23505/i.test(err.message)) return true;
  return false;
}

/**
 * Resolve the existing interaction UUID when we know a duplicate exists.
 */
async function resolveExistingInteraction(
  supabase: SupabaseClient,
  dedupeKey: string,
  input: CanonicalInteractionInput,
): Promise<string | null> {
  // Primary: look up by dedupe_key (fastest, most reliable)
  const { data: byKey } = await supabase
    .from("interactions")
    .select("id")
    .eq("dedupe_key", dedupeKey)
    .limit(1)
    .maybeSingle();
  if (byKey?.id) return byKey.id as string;

  // Fallback: for emails with provider message ID
  if (input.gmail_message_id) {
    const { data } = await supabase
      .from("interactions")
      .select("id")
      .eq("lead_id", input.lead_id)
      .eq("gmail_message_id", input.gmail_message_id)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }

  // Last resort: match by lead + type + timestamp
  const { data } = await supabase
    .from("interactions")
    .select("id")
    .eq("lead_id", input.lead_id)
    .eq("type", input.type)
    .eq("occurred_at", input.occurred_at)
    .limit(1)
    .maybeSingle();

  return (data?.id as string) ?? null;
}

/**
 * Insert an interaction and project a matching timeline item.
 * Returns the interaction UUID, whether timeline was projected,
 * and whether the interaction was a detected duplicate.
 *
 * DEDUPLICATION:
 *   - Primary: DB UNIQUE INDEX on dedupe_key blocks re-inserts
 *   - Secondary: ON CONFLICT in timelineProjector for timeline rows
 *   - On duplicate: returns duplicate=true with resolved interaction UUID
 *     and still attempts timeline projection (idempotent) so historical
 *     rows missing from the timeline get filled.
 */
export async function createCanonicalInteraction(
  supabase: SupabaseClient,
  input: CanonicalInteractionInput,
): Promise<CanonicalInteractionResult> {
  const dedupeKey = buildDedupeKey(input);

  // 1. Insert the interaction with dedupe_key
  const interactionRow: Record<string, unknown> = {
    lead_id: input.lead_id,
    type: input.type,
    source: input.source,
    body_text: input.body_text,
    occurred_at: input.occurred_at,
    direction: input.direction ?? null,
    subject: input.subject ?? null,
    from_email: input.from_email ?? null,
    to_email: input.to_email ?? null,
    gmail_message_id: input.gmail_message_id ?? null,
    gmail_thread_id: input.gmail_thread_id ?? null,
    ai_intent: input.ai_intent ?? null,
    ai_summary: input.ai_summary ?? null,
    ai_reply_worthy: input.ai_reply_worthy ?? null,
    hidden: input.hidden ?? false,
    dedupe_key: dedupeKey,
  };

  let interactionId: string | null = null;
  let isDuplicate = false;

  const { data: inserted, error: insertErr } = await supabase
    .from("interactions")
    .insert(interactionRow)
    .select("id")
    .single();

  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      // Duplicate — resolve the existing row's UUID
      isDuplicate = true;
      interactionId = await resolveExistingInteraction(supabase, dedupeKey, input);
      if (!interactionId) {
        console.warn(`[canonicalInteraction] Duplicate skipped (dedupe_key=${dedupeKey}) but could not resolve existing row for lead ${input.lead_id}`);
        return { interaction_id: null, timeline_projected: false, duplicate: true, error: "duplicate_unresolved" };
      }
      console.log(`[canonicalInteraction] Duplicate skipped (dedupe_key=${dedupeKey}) → existing ${interactionId}`);
    } else {
      // Non-duplicate error — genuine failure
      return { interaction_id: null, timeline_projected: false, duplicate: false, error: insertErr.message };
    }
  } else {
    interactionId = inserted?.id as string;
  }

  // 2. Project into lead_timeline_items (only if workspace_id is available)
  //    This is idempotent via ON CONFLICT (lead_id, dedupe_key) in timelineProjector.
  let timelineProjected = false;
  if (input.workspace_id && interactionId) {
    const channel = deriveChannel(input.type);

    try {
      await projectTimelineItem(supabase, {
        workspace_id: input.workspace_id,
        lead_id: input.lead_id,
        contact_id: input.contact_id ?? null,
        conversation_id: input.conversation_id ?? null,
        channel,
        provider: input.provider ?? input.source,
        direction: input.direction ?? null,
        event_type: input.type,
        occurred_at: input.occurred_at,
        source_table: "interactions",
        source_id: interactionId,
        snippet_text: input.body_text?.substring(0, 500) ?? null,
        subject: input.subject ?? null,
        status_json: input.status_json ?? {},
        metadata_json: {
          ...(input.metadata_json ?? {}),
          gmail_message_id: input.gmail_message_id ?? undefined,
          gmail_thread_id: input.gmail_thread_id ?? undefined,
          from_email: input.from_email ?? undefined,
          to_email: input.to_email ?? undefined,
          ai_summary: input.ai_summary ?? undefined,
          source: input.source,
        },
        dedupe_key: dedupeKey,
      });
      timelineProjected = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[canonicalInteraction] Timeline projection failed for interaction ${interactionId}: ${msg}`);
    }
  }

  return { interaction_id: interactionId, timeline_projected: timelineProjected, duplicate: isDuplicate };
}
