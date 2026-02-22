// ============================================================
// MetaWhatsAppProvider — placeholder (Phase 1 implementation)
// ============================================================

import type { IWhatsAppProvider } from "../provider.ts";
import type {
  SendWhatsAppParams,
  SendWhatsAppResult,
  WhatsAppHealthResult,
  WebhookPayload,
} from "../types.ts";

export class MetaWhatsAppProvider implements IWhatsAppProvider {
  readonly providerType = "meta" as const;

  constructor(
    private readonly _accessToken: string,
    private readonly _phoneNumberId: string,
  ) {}

  async send(_params: SendWhatsAppParams): Promise<SendWhatsAppResult> {
    throw new Error("MetaWhatsAppProvider.send: not implemented yet (Phase 1)");
  }

  async verifyWebhookSignature(_request: Request, _rawBody: string): Promise<void> {
    throw new Error("MetaWhatsAppProvider.verifyWebhookSignature: not implemented yet (Phase 1)");
  }

  async parseWebhook(_request: Request, _rawBody: string): Promise<WebhookPayload> {
    throw new Error("MetaWhatsAppProvider.parseWebhook: not implemented yet (Phase 1)");
  }

  async checkHealth(): Promise<WhatsAppHealthResult> {
    throw new Error("MetaWhatsAppProvider.checkHealth: not implemented yet (Phase 1)");
  }
}
