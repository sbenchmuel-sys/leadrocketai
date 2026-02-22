// ============================================================
// MetaWhatsAppProvider — Phase 1: signature verification
// ============================================================

import type { IWhatsAppProvider } from "../provider.ts";
import type {
  SendWhatsAppParams,
  SendWhatsAppResult,
  WhatsAppHealthResult,
  WebhookPayload,
} from "../types.ts";

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
  // Header format: "sha256=<hex>"
  const providedHex = headerValue.startsWith("sha256=")
    ? headerValue.slice(7)
    : headerValue;

  if (!providedHex || providedHex.length !== expectedHex.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    mismatch |= expectedHex.charCodeAt(i) ^ providedHex.charCodeAt(i);
  }
  return mismatch === 0;
}

export class MetaWhatsAppProvider implements IWhatsAppProvider {
  readonly providerType = "meta" as const;

  constructor(
    private readonly _accessToken: string,
    private readonly _phoneNumberId: string,
  ) {}

  async send(_params: SendWhatsAppParams): Promise<SendWhatsAppResult> {
    throw new Error("MetaWhatsAppProvider.send: not implemented yet (Phase 1)");
  }

  async verifyWebhookSignature(request: Request, rawBody: string): Promise<void> {
    const secret = Deno.env.get("META_APP_SECRET");
    if (!secret) throw new Error("META_APP_SECRET not configured");
    const valid = await verifyMetaSignature(request, rawBody, secret);
    if (!valid) throw new Error("Invalid Meta webhook signature");
  }

  async parseWebhook(_request: Request, _rawBody: string): Promise<WebhookPayload> {
    throw new Error("MetaWhatsAppProvider.parseWebhook: not implemented yet (Phase 1)");
  }

  async checkHealth(): Promise<WhatsAppHealthResult> {
    throw new Error("MetaWhatsAppProvider.checkHealth: not implemented yet (Phase 1)");
  }
}
