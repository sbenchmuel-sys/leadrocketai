// ============================================================
// IWhatsAppProvider — interface that Meta + Twilio implement
// ============================================================

import type {
  SendWhatsAppParams,
  SendWhatsAppResult,
  WhatsAppHealthResult,
  WebhookPayload,
} from "./types.ts";

export interface IWhatsAppProvider {
  readonly providerType: "meta" | "twilio";

  /** Send a WhatsApp message */
  send(params: SendWhatsAppParams): Promise<SendWhatsAppResult>;

  /** Verify webhook signature; throws on failure */
  verifyWebhookSignature(request: Request, rawBody: string): Promise<void>;

  /** Parse raw webhook payload into normalized form */
  parseWebhook(request: Request, rawBody: string): Promise<WebhookPayload>;

  /** Health check for the connection */
  checkHealth(): Promise<WhatsAppHealthResult>;
}
