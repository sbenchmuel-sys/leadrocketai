// ============================================================
// TwilioWhatsAppProvider — placeholder (Phase 2+ implementation)
// ============================================================

import type { IWhatsAppProvider } from "../provider.ts";
import type {
  SendWhatsAppParams,
  SendWhatsAppResult,
  WhatsAppHealthResult,
  WebhookPayload,
} from "../types.ts";

export class TwilioWhatsAppProvider implements IWhatsAppProvider {
  readonly providerType = "twilio" as const;

  constructor(
    private readonly _accountSid: string,
    private readonly _authToken: string,
    private readonly _fromNumber: string,
  ) {}

  async send(_params: SendWhatsAppParams): Promise<SendWhatsAppResult> {
    throw new Error("TwilioWhatsAppProvider.send: not implemented yet (Phase 2)");
  }

  async verifyWebhookSignature(_request: Request, _rawBody: string): Promise<void> {
    throw new Error("TwilioWhatsAppProvider.verifyWebhookSignature: not implemented yet (Phase 2)");
  }

  async parseWebhook(_request: Request, _rawBody: string): Promise<WebhookPayload> {
    throw new Error("TwilioWhatsAppProvider.parseWebhook: not implemented yet (Phase 2)");
  }

  async checkHealth(): Promise<WhatsAppHealthResult> {
    throw new Error("TwilioWhatsAppProvider.checkHealth: not implemented yet (Phase 2)");
  }
}
