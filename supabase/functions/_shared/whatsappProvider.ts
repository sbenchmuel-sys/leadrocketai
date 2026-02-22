/**
 * WhatsApp Provider Abstraction Layer
 * 
 * Defines a provider-agnostic interface for WhatsApp operations.
 * Implementations: MetaWhatsAppProvider (now), TwilioWhatsAppProvider (future).
 */

import { safeDecryptToken } from "./encryption.ts";

// ── Types ─────────────────────────────────────────────────

export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  wabaId?: string;
}

export interface SendMessageParams {
  to: string;            // E.164 phone number (digits only)
  body: string;          // Message text
  phoneNumberId: string; // Sender phone number ID
  accessToken: string;   // Decrypted access token
}

export interface SendMessageResult {
  ok: boolean;
  providerMessageId: string | null;
  error?: string;
}

export interface HealthCheckResult {
  healthy: boolean;
  status: "active" | "token_invalid" | "error";
  verifiedName?: string | null;
  qualityRating?: string | null;
  error?: string;
}

export interface WebhookVerification {
  isValid: boolean;
  challenge?: string;
}

export interface ParsedInboundMessage {
  providerMessageId: string;
  senderPhone: string;
  timestamp: string;
  bodyText: string;
  mediaType: string | null;
  rawMessage: unknown;
}

export interface ParsedStatusUpdate {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipientId: string;
}

export interface ParsedWebhookPayload {
  phoneNumberId: string | null;
  messages: ParsedInboundMessage[];
  statusUpdates: ParsedStatusUpdate[];
}

// ── Provider Interface ────────────────────────────────────

export interface WhatsAppProvider {
  readonly name: string;  // 'meta' | 'twilio'

  /** Send a text message */
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;

  /** Health check against the provider API */
  checkHealth(accessToken: string, phoneNumberId: string): Promise<HealthCheckResult>;

  /** Verify webhook subscription request (GET) */
  verifyWebhook(params: Record<string, string>, verifyToken: string): WebhookVerification;

  /** Validate webhook signature on POST payload */
  validateSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean;

  /** Parse a raw webhook POST body into normalized messages + status updates */
  parseWebhookPayload(body: unknown): ParsedWebhookPayload;

  /** Decrypt stored credentials into usable tokens */
  decryptCredentials(credentialsEncrypted: string): Promise<WhatsAppCredentials>;
}

// ── Meta Implementation ───────────────────────────────────

const META_API = "https://graph.facebook.com/v21.0";

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = "meta";

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const waPayload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "text",
      text: { body: params.body },
    };

    const res = await fetch(`${META_API}/${params.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(waPayload),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        ok: false,
        providerMessageId: null,
        error: data?.error?.message ?? JSON.stringify(data),
      };
    }

    return {
      ok: true,
      providerMessageId: data?.messages?.[0]?.id ?? null,
    };
  }

  async checkHealth(accessToken: string, phoneNumberId: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${META_API}/${phoneNumberId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        return { healthy: false, status: "token_invalid" };
      }

      const data = await res.json();
      return {
        healthy: true,
        status: "active",
        verifiedName: data.verified_name ?? null,
        qualityRating: data.quality_rating ?? null,
      };
    } catch (err) {
      return { healthy: false, status: "error", error: (err as Error).message };
    }
  }

  verifyWebhook(params: Record<string, string>, verifyToken: string): WebhookVerification {
    const mode = params["hub.mode"];
    const token = params["hub.verify_token"];
    const challenge = params["hub.challenge"];

    if (mode === "subscribe" && token === verifyToken) {
      return { isValid: true, challenge: challenge ?? "" };
    }
    return { isValid: false };
  }

  validateSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
    if (!signatureHeader || !appSecret) return false;

    // Meta sends: sha256=<hex>
    const expected = signatureHeader.replace("sha256=", "");
    if (!expected) return false;

    // Use Web Crypto for HMAC-SHA256
    // Note: this is a sync check stub — actual implementation uses async crypto
    // We handle this in the webhook by calling validateSignatureAsync instead
    return true; // Placeholder — use async version
  }

  /** Async signature validation using Web Crypto API */
  async validateSignatureAsync(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
    if (!signatureHeader || !appSecret) return false;

    const expected = signatureHeader.replace("sha256=", "").trim();
    if (!expected) return false;

    try {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(appSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
      const computed = Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

      // Constant-time comparison
      if (computed.length !== expected.length) return false;
      let mismatch = 0;
      for (let i = 0; i < computed.length; i++) {
        mismatch |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      return mismatch === 0;
    } catch (err) {
      console.error("[MetaWhatsAppProvider] Signature validation error:", err);
      return false;
    }
  }

  parseWebhookPayload(body: unknown): ParsedWebhookPayload {
    const entries = (body as any)?.entry ?? [];
    const result: ParsedWebhookPayload = {
      phoneNumberId: null,
      messages: [],
      statusUpdates: [],
    };

    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        if (change?.field !== "messages") continue;
        const value = change?.value;
        if (!value) continue;

        // Capture phone_number_id from metadata
        if (!result.phoneNumberId && value?.metadata?.phone_number_id) {
          result.phoneNumberId = value.metadata.phone_number_id;
        }

        // Parse status updates
        for (const statusEvent of (value?.statuses ?? [])) {
          const id = statusEvent?.id;
          const status = statusEvent?.status;
          const recipientId = statusEvent?.recipient_id ?? "";
          if (!id || !status) continue;
          if (!["sent", "delivered", "read", "failed"].includes(status)) continue;

          result.statusUpdates.push({
            providerMessageId: id,
            status: status as ParsedStatusUpdate["status"],
            recipientId,
          });
        }

        // Parse messages
        for (const msg of (value?.messages ?? [])) {
          const providerMessageId = msg?.id;
          if (!providerMessageId) continue;

          const senderPhone = msg?.from ?? "";
          const timestamp = msg?.timestamp
            ? new Date(parseInt(msg.timestamp) * 1000).toISOString()
            : new Date().toISOString();

          result.messages.push({
            providerMessageId,
            senderPhone,
            timestamp,
            bodyText: extractBodyText(msg),
            mediaType: msg.type !== "text" ? msg.type : null,
            rawMessage: msg,
          });
        }
      }
    }

    return result;
  }

  async decryptCredentials(credentialsEncrypted: string): Promise<WhatsAppCredentials> {
    const credsJson = await safeDecryptToken(credentialsEncrypted);
    const creds = JSON.parse(credsJson);
    const accessToken = await safeDecryptToken(creds.access_token);

    return {
      accessToken,
      phoneNumberId: creds.phone_number_id,
      wabaId: creds.waba_id ?? undefined,
    };
  }
}

// ── Provider Registry ─────────────────────────────────────

const providers: Record<string, WhatsAppProvider> = {
  meta: new MetaWhatsAppProvider(),
};

export function getWhatsAppProvider(providerName: string = "meta"): WhatsAppProvider {
  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Unknown WhatsApp provider: ${providerName}. Available: ${Object.keys(providers).join(", ")}`);
  }
  return provider;
}

// ── Shared Utilities ──────────────────────────────────────

function extractBodyText(msg: any): string {
  if (msg.type === "text") return msg.text?.body ?? "";
  if (msg.type === "image") return `[Image] ${msg.image?.caption ?? ""}`;
  if (msg.type === "document") return `[Document] ${msg.document?.filename ?? ""}`;
  if (msg.type === "audio") return "[Audio message]";
  if (msg.type === "video") return `[Video] ${msg.video?.caption ?? ""}`;
  if (msg.type === "location") return `[Location] ${msg.location?.latitude},${msg.location?.longitude}`;
  if (msg.type === "contacts") return "[Contact card]";
  if (msg.type === "sticker") return "[Sticker]";
  if (msg.type === "reaction") return `[Reaction] ${msg.reaction?.emoji ?? ""}`;
  return `[${msg.type ?? "unknown"}]`;
}

/** Normalize phone to E.164 digits only */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}
