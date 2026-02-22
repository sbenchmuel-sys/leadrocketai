// ============================================================
// MetaWhatsAppProvider — implements IWhatsAppProvider for Meta
// ============================================================

import type { IWhatsAppProvider } from "../provider.ts";
import type {
  SendWhatsAppParams,
  SendWhatsAppResult,
  WhatsAppHealthResult,
} from "../types.ts";

const WA_API = "https://graph.facebook.com/v21.0";

/**
 * Verify Meta X-Hub-Signature-256 header.
 * Returns true if valid, false otherwise. Never logs secrets.
 */
export async function verifyMetaSignature(
  _req: Request,
  rawBody: string,
  metaAppSecret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(metaAppSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expectedHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const headerValue = _req.headers.get("x-hub-signature-256") ?? "";
  const providedHex = headerValue.startsWith("sha256=")
    ? headerValue.slice(7)
    : headerValue;

  if (!providedHex || providedHex.length !== expectedHex.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    mismatch |= expectedHex.charCodeAt(i) ^ providedHex.charCodeAt(i);
  }
  return mismatch === 0;
}

export class MetaWhatsAppProvider implements IWhatsAppProvider {
  readonly providerType = "meta" as const;

  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
  ) {}

  async send(params: SendWhatsAppParams): Promise<SendWhatsAppResult> {
    const normalizedTo = params.to.replace(/\D/g, "");

    const waPayload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizedTo,
      type: "text",
      text: { body: params.body },
    };

    // Add reply context if provided
    if (params.replyToMessageId) {
      waPayload.context = { message_id: params.replyToMessageId };
    }

    const res = await fetch(`${WA_API}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(waPayload),
    });

    const data = await res.json();

    if (!res.ok) {
      const errMsg = data?.error?.message ?? JSON.stringify(data);
      throw new Error(`Meta API error (${res.status}): ${errMsg}`);
    }

    return {
      providerMessageId: data?.messages?.[0]?.id ?? "",
    };
  }

  async checkHealth(): Promise<WhatsAppHealthResult> {
    try {
      const res = await fetch(
        `${WA_API}/${this.phoneNumberId}`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } },
      );

      if (!res.ok) {
        return {
          healthy: false,
          status: "token_invalid",
          phoneNumberId: this.phoneNumberId,
          errorMessage: `API returned ${res.status}`,
        };
      }

      const data = await res.json();

      return {
        healthy: true,
        status: "active",
        phoneNumberId: this.phoneNumberId,
        verifiedName: data.verified_name ?? undefined,
      };
    } catch (err: any) {
      return {
        healthy: false,
        status: "error",
        phoneNumberId: this.phoneNumberId,
        errorMessage: err.message,
      };
    }
  }
}
