// ============================================================
// IWhatsAppProvider — interface that Meta + Twilio implement
// ============================================================

import type {
  SendWhatsAppParams,
  SendWhatsAppResult,
  WhatsAppHealthResult,
} from "./types.ts";

export interface IWhatsAppProvider {
  readonly providerType: "meta" | "twilio";

  /** Send a WhatsApp message */
  send(params: SendWhatsAppParams): Promise<SendWhatsAppResult>;

  /** Health check for the connection */
  checkHealth(): Promise<WhatsAppHealthResult>;
}
