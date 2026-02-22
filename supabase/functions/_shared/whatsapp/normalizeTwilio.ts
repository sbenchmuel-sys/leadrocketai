// ============================================================
// normalizeTwilio.ts — convert Twilio webhook payloads into
// InboundMessageEvent[] + MessageStatusEvent[]
// ============================================================

import type {
  InboundMessageEvent,
  MessageStatusEvent,
  NormalizedWebhookResult,
  Attachment,
} from "../types.ts";

// ── Helpers ─────────────────────────────────────────────────

function digits(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

function stripWhatsAppPrefix(val: string): string {
  return val.startsWith("whatsapp:") ? val.slice(9) : val;
}

/**
 * Stable hash fallback for provider_event_id.
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

// ============================================================
// normalizeTwilioWebhook
//
// Twilio sends one event per webhook POST (form-encoded).
// The SmsStatus field determines if it's an inbound message
// or a status callback.
// ============================================================

export function normalizeTwilioWebhook(
  params: Record<string, string>,
): NormalizedWebhookResult {
  const inboundEvents: InboundMessageEvent[] = [];
  const statusEvents: MessageStatusEvent[] = [];

  const messageSid = params.MessageSid ?? params.SmsSid ?? "";
  const from = digits(stripWhatsAppPrefix(params.From ?? ""));
  const to = digits(stripWhatsAppPrefix(params.To ?? ""));
  const body = params.Body ?? null;
  const smsStatus = (params.SmsStatus ?? params.MessageStatus ?? "").toLowerCase();

  // Determine if this is an inbound message or status update
  // Twilio status callbacks have MessageStatus; inbound messages have SmsStatus="received"
  const isStatusCallback = ["sent", "delivered", "read", "failed", "undelivered"].includes(smsStatus);
  const isInbound = smsStatus === "received" || (!isStatusCallback && !!body && from);

  if (isInbound) {
    const providerEventId = messageSid || stableEventId({
      type: "inbound",
      from,
      to,
      timestamp: new Date().toISOString(),
    });

    // Extract attachments (Twilio sends NumMedia, MediaUrl0..N, MediaContentType0..N)
    const attachments: Attachment[] = [];
    const numMedia = parseInt(params.NumMedia ?? "0", 10);
    for (let i = 0; i < numMedia; i++) {
      attachments.push({
        url: params[`MediaUrl${i}`] ?? null,
        mime_type: params[`MediaContentType${i}`] ?? null,
        filename: null,
      });
    }

    const messageType = numMedia > 0
      ? (params.MediaContentType0?.startsWith("image/") ? "image" :
         params.MediaContentType0?.startsWith("video/") ? "video" :
         params.MediaContentType0?.startsWith("audio/") ? "audio" : "document")
      : "text";

    inboundEvents.push({
      provider: "twilio",
      external_message_id: messageSid,
      provider_event_id: providerEventId,
      from,
      to,
      text: body,
      message_type: messageType,
      timestamp: new Date().toISOString(),
      attachments,
      context_message_id: null, // Twilio doesn't provide reply-to context
      raw: params as unknown as Record<string, unknown>,
    });
  } else if (isStatusCallback) {
    const mappedStatus = smsStatus === "undelivered" ? "failed" : smsStatus;

    const providerEventId = messageSid
      ? `${messageSid}:${mappedStatus}`
      : stableEventId({
          type: "status",
          message_id: messageSid,
          status: mappedStatus,
          timestamp: new Date().toISOString(),
        });

    statusEvents.push({
      provider: "twilio",
      external_message_id: messageSid,
      provider_event_id: providerEventId,
      status: mappedStatus as "sent" | "delivered" | "read" | "failed",
      recipient_id: to,
      timestamp: new Date().toISOString(),
      error_code: params.ErrorCode ?? null,
      error_message: params.ErrorMessage ?? null,
      raw: params as unknown as Record<string, unknown>,
    });
  }

  // For Twilio, the "phoneNumberId" equivalent is the To number (the Twilio sender)
  const phoneNumberId = isInbound ? to : from;

  return { inboundEvents, statusEvents, phoneNumberId };
}
