// ============================================================
// WhatsApp Provider Abstraction — Shared Types
// ============================================================

/** Supported WhatsApp providers */
export type WhatsAppProviderType = "meta" | "twilio";

// ============================================================
// Normalized Event Types (Phase 3)
// ============================================================

export interface Attachment {
  url: string | null;
  mime_type: string | null;
  filename: string | null;
}

/** Normalized inbound message from any provider */
export interface InboundMessageEvent {
  provider: WhatsAppProviderType;
  external_message_id: string;
  provider_event_id: string;
  from: string;            // E.164 digits only
  to: string;              // E.164 digits only (receiving phone number id for Meta)
  text: string | null;
  message_type: string;    // text, image, document, audio, video, etc.
  timestamp: string;       // ISO-8601
  attachments: Attachment[];
  context_message_id: string | null; // reply-to
  raw: Record<string, unknown>;
}

/** Normalized status update from any provider */
export interface MessageStatusEvent {
  provider: WhatsAppProviderType;
  external_message_id: string;
  provider_event_id: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipient_id: string;
  timestamp: string;       // ISO-8601
  error_code: string | null;
  error_message: string | null;
  raw: Record<string, unknown>;
}

/** Combined result from normalization */
export interface NormalizedWebhookResult {
  inboundEvents: InboundMessageEvent[];
  statusEvents: MessageStatusEvent[];
  /** Phone number ID extracted from metadata, used for routing */
  phoneNumberId: string | null;
}

// ============================================================
// Channel Events row shape (matches channel_events table)
// ============================================================

export interface ChannelEventRow {
  workspace_id: string | null;
  channel: "whatsapp";
  provider: WhatsAppProviderType;
  event_type: "inbound_message" | "status_update";
  provider_event_id: string;
  payload_normalized: Record<string, unknown>;
  payload_raw: Record<string, unknown>;
}

// ============================================================
// Provider Interface — implemented by MetaProvider, TwilioProvider
// ============================================================

export interface SendWhatsAppParams {
  to: string;
  body: string;
  mediaUrl?: string;
  replyToMessageId?: string;
}

export interface SendWhatsAppResult {
  providerMessageId: string;
}

export interface WhatsAppHealthResult {
  healthy: boolean;
  status: "active" | "token_invalid" | "error" | "inactive";
  phoneNumberId?: string;
  verifiedName?: string;
  errorMessage?: string;
}

export type WebhookPayload =
  | { kind: "verification"; challenge: string }
  | { kind: "message"; messages: InboundMessageEvent[] }
  | { kind: "status"; statuses: MessageStatusEvent[] }
  | { kind: "ignored" };
