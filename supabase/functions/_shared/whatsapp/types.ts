// ============================================================
// WhatsApp Provider Abstraction — Shared Types
// ============================================================

/** Supported WhatsApp providers */
export type WhatsAppProviderType = "meta" | "twilio";

/** Normalized inbound message from any provider */
export interface NormalizedInboundMessage {
  providerMessageId: string;
  from: string;            // E.164 phone number
  to: string;              // E.164 phone number
  timestamp: string;       // ISO-8601
  type: "text" | "image" | "document" | "audio" | "video" | "reaction" | "unknown";
  body?: string;
  mediaUrl?: string;
  mediaMimeType?: string;
  replyToMessageId?: string;
}

/** Normalized status update from any provider */
export interface NormalizedStatusUpdate {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Params for sending a message through any provider */
export interface SendWhatsAppParams {
  to: string;              // E.164 phone number
  body: string;
  mediaUrl?: string;
  replyToMessageId?: string;
}

/** Result after sending */
export interface SendWhatsAppResult {
  providerMessageId: string;
}

/** Health check result */
export interface WhatsAppHealthResult {
  healthy: boolean;
  status: "active" | "token_invalid" | "error" | "inactive";
  phoneNumberId?: string;
  verifiedName?: string;
  errorMessage?: string;
}

/** Webhook parse result — discriminated union */
export type WebhookPayload =
  | { kind: "verification"; challenge: string }
  | { kind: "message"; messages: NormalizedInboundMessage[] }
  | { kind: "status"; statuses: NormalizedStatusUpdate[] }
  | { kind: "ignored" };
