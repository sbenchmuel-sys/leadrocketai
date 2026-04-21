// ============================================================
// timelineProjection — single client-side source of truth for
// projecting an `interactions` row into a `lead_timeline_items`
// upsert payload.
//
// Why this exists:
//   Before this helper, channel inference, direction inference,
//   dedupe-key construction, and the timeline payload shape were
//   duplicated in:
//     - src/lib/supabaseQueries.ts → insertInteraction (write path)
//     - src/lib/timelineDriftAudit.ts → repairTimelineDrift (backfill)
//
//   Even when the copies matched, that's a future drift point.
//   This module centralizes the rules so both paths produce
//   byte-identical timeline rows.
//
// Design constraints:
//   - PURE: no DB access, no async, no side effects
//   - INPUT: interaction-like row + workspace_id
//   - OUTPUT: dedupe key + ready-to-upsert timeline payload
//   - ALIGNMENT: server-side canonical projection lives in
//     supabase/functions/_shared/canonicalInteraction.ts and
//     timelineProjector.ts. Keep the *shape* aligned. If the
//     server gains a shared client/server module later, retire
//     this file in favor of that.
// ============================================================

// ---------- Inference (kept aligned with leadActivity.ts) ----------

export function inferChannelFromInteractionType(type: string): string {
  if (!type) return "system";
  if (type.includes("email")) return "email";
  if (type.includes("whatsapp")) return "whatsapp";
  if (type.includes("sms")) return "sms";
  if (type.includes("call") || type.includes("voice")) return "voice";
  if (type.includes("meeting")) return "meeting";
  return "system";
}

export function inferDirectionFromInteractionType(
  type: string,
): "inbound" | "outbound" | null {
  if (!type) return null;
  if (type.includes("inbound")) return "inbound";
  if (type.includes("outbound")) return "outbound";
  return null;
}

// ---------- Dedupe key ----------

/**
 * Canonical dedupe key format for timeline rows that mirror an
 * `interactions` row. Stable across writes and repair backfills.
 */
export function interactionDedupeKey(interactionId: string): string {
  return `interaction:${interactionId}`;
}

// ---------- Projection ----------

export interface InteractionLike {
  id: string;
  lead_id: string;
  type: string;
  source?: string | null;
  occurred_at: string;
  subject?: string | null;
  body_text?: string | null;
  direction?: "inbound" | "outbound" | null;
}

export interface TimelineProjectionOverrides {
  /** Optional channel override; auto-derived from `type` when omitted. */
  channel?: string;
  /** Optional provider override; defaults to `source` (or `'manual'`). */
  provider?: string;
}

export interface TimelineProjectionResult {
  dedupeKey: string;
  payload: {
    workspace_id: string;
    lead_id: string;
    channel: string;
    provider: string;
    direction: "inbound" | "outbound" | null;
    event_type: string;
    occurred_at: string;
    source_table: "interactions";
    source_id: string;
    subject: string | null;
    snippet_text: string;
    dedupe_key: string;
  };
}

/**
 * Build the canonical `lead_timeline_items` upsert payload for an
 * interaction. Pure — callers handle the DB upsert with
 * `{ onConflict: 'lead_id,dedupe_key' }`.
 */
export function buildTimelineProjectionFromInteraction(
  interaction: InteractionLike,
  workspaceId: string,
  overrides: TimelineProjectionOverrides = {},
): TimelineProjectionResult {
  const channel = overrides.channel || inferChannelFromInteractionType(interaction.type);
  const direction = interaction.direction ?? inferDirectionFromInteractionType(interaction.type);
  const provider = overrides.provider || interaction.source || "manual";
  const dedupeKey = interactionDedupeKey(interaction.id);

  return {
    dedupeKey,
    payload: {
      workspace_id: workspaceId,
      lead_id: interaction.lead_id,
      channel,
      provider,
      direction,
      event_type: interaction.type,
      occurred_at: interaction.occurred_at,
      source_table: "interactions",
      source_id: interaction.id,
      subject: interaction.subject ?? null,
      snippet_text: (interaction.body_text ?? "").slice(0, 500),
      dedupe_key: dedupeKey,
    },
  };
}
