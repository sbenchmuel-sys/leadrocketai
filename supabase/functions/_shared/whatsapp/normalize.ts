// ============================================================
// normalize.ts — convert provider webhook payloads into
// InboundMessageEvent[] + MessageStatusEvent[]
// ============================================================

import type {
  InboundMessageEvent,
  MessageStatusEvent,
  NormalizedWebhookResult,
  Attachment,
  ChannelEventRow,
} from "./types.ts";

// ── Helpers ─────────────────────────────────────────────────

function digits(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

function epochToIso(epoch: string | number | undefined): string {
  if (!epoch) return new Date().toISOString();
  const n = typeof epoch === "string" ? parseInt(epoch, 10) : epoch;
  return isNaN(n) ? new Date().toISOString() : new Date(n * 1000).toISOString();
}

/**
 * Stable hash fallback for provider_event_id when no native id exists.
 * Uses a simple FNV-1a-like hash of the concatenated fields.
 */
function stableEventId(parts: Record<string, string>): string {
  const input = Object.values(parts).join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `synth:${hash.toString(16)}`;
}

// ── Extract text from Meta message by type ──────────────────

function extractText(msg: any): string | null {
  switch (msg?.type) {
    case "text":
      return msg.text?.body ?? null;
    case "image":
      return msg.image?.caption ? `[Image] ${msg.image.caption}` : "[Image]";
    case "document":
      return msg.document?.filename ? `[Document] ${msg.document.filename}` : "[Document]";
    case "audio":
      return "[Audio message]";
    case "video":
      return msg.video?.caption ? `[Video] ${msg.video.caption}` : "[Video]";
    case "location":
      return `[Location] ${msg.location?.latitude ?? "?"},${msg.location?.longitude ?? "?"}`;
    case "contacts":
      return "[Contact card]";
    case "sticker":
      return "[Sticker]";
    case "reaction":
      return `[Reaction] ${msg.reaction?.emoji ?? ""}`;
    default:
      return `[${msg?.type ?? "unknown"}]`;
  }
}

// ── Extract attachments from Meta message ───────────────────

function extractAttachments(msg: any): Attachment[] {
  const type: string = msg?.type ?? "";
  const media = msg?.[type]; // e.g. msg.image, msg.document, msg.video

  if (!media || !["image", "document", "audio", "video", "sticker"].includes(type)) {
    return [];
  }

  return [
    {
      url: media.url ?? media.id ?? null, // Meta may provide media id instead of url
      mime_type: media.mime_type ?? null,
      filename: media.filename ?? null,
    },
  ];
}

// ============================================================
// normalizeMetaWebhook
// ============================================================

export function normalizeMetaWebhook(
  body: Record<string, unknown>,
): NormalizedWebhookResult {
  const inboundEvents: InboundMessageEvent[] = [];
  const statusEvents: MessageStatusEvent[] = [];
  let phoneNumberId: string | null = null;

  const entries = (body?.entry as any[]) ?? [];

  for (const entry of entries) {
    const changes = (entry?.changes as any[]) ?? [];
    for (const change of changes) {
      if (change?.field !== "messages") continue;

      const value = change?.value;
      if (!value) continue;

      const pnId: string = value?.metadata?.phone_number_id ?? "";
      if (pnId && !phoneNumberId) phoneNumberId = pnId;

      // ── Inbound messages ────────────────────────────────
      const messages = (value?.messages as any[]) ?? [];
      for (const msg of messages) {
        const nativeId: string = msg?.id ?? "";
        const from = digits(msg?.from ?? "");
        const timestamp = epochToIso(msg?.timestamp);

        const providerEventId = nativeId || stableEventId({
          type: "inbound",
          from,
          to: pnId,
          timestamp,
        });

        inboundEvents.push({
          provider: "meta",
          external_message_id: nativeId,
          provider_event_id: providerEventId,
          from,
          to: pnId,
          text: extractText(msg),
          message_type: msg?.type ?? "unknown",
          timestamp,
          attachments: extractAttachments(msg),
          context_message_id: msg?.context?.id ?? null,
          raw: msg as Record<string, unknown>,
        });
      }

      // ── Status updates ──────────────────────────────────
      const statuses = (value?.statuses as any[]) ?? [];
      for (const st of statuses) {
        const nativeId: string = st?.id ?? "";
        const status: string = st?.status ?? "";

        if (!["sent", "delivered", "read", "failed"].includes(status)) continue;

        // Composite key: same message can have multiple status transitions
        const providerEventId = nativeId
          ? `${nativeId}:${status}`
          : stableEventId({
              type: "status",
              message_id: nativeId,
              status,
              timestamp: st?.timestamp ?? "",
            });

        statusEvents.push({
          provider: "meta",
          external_message_id: nativeId,
          provider_event_id: providerEventId,
          status: status as MessageStatusEvent["status"],
          recipient_id: digits(st?.recipient_id ?? ""),
          timestamp: epochToIso(st?.timestamp),
          error_code: st?.errors?.[0]?.code?.toString() ?? null,
          error_message: st?.errors?.[0]?.title ?? null,
          raw: st as Record<string, unknown>,
        });
      }
    }
  }

  return { inboundEvents, statusEvents, phoneNumberId };
}

// ============================================================
// toChannelEventRows — convert normalized results into rows
// ready for channel_events table insertion
// ============================================================

export function toChannelEventRows(
  result: NormalizedWebhookResult,
  workspaceId: string | null,
  rawPayload: Record<string, unknown>,
): ChannelEventRow[] {
  const rows: ChannelEventRow[] = [];

  for (const evt of result.inboundEvents) {
    rows.push({
      workspace_id: workspaceId,
      channel: "whatsapp",
      provider: evt.provider,
      event_type: "inbound_message",
      provider_event_id: evt.provider_event_id,
      payload_normalized: {
        external_message_id: evt.external_message_id,
        from: evt.from,
        to: evt.to,
        text: evt.text,
        message_type: evt.message_type,
        timestamp: evt.timestamp,
        attachments: evt.attachments,
        context_message_id: evt.context_message_id,
      },
      payload_raw: rawPayload,
    });
  }

  for (const evt of result.statusEvents) {
    rows.push({
      workspace_id: workspaceId,
      channel: "whatsapp",
      provider: evt.provider,
      event_type: "status_update",
      provider_event_id: evt.provider_event_id,
      payload_normalized: {
        external_message_id: evt.external_message_id,
        status: evt.status,
        recipient_id: evt.recipient_id,
        timestamp: evt.timestamp,
        error_code: evt.error_code,
        error_message: evt.error_message,
      },
      payload_raw: rawPayload,
    });
  }

  return rows;
}
