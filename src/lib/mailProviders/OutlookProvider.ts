// ============================================================
// OutlookProvider — MVP STUB
// Full implementation deferred to Phase 2.
// ============================================================

import type { IMailProvider, SendEmailParams, SendEmailResult } from "./types";

export class OutlookProvider implements IMailProvider {
  readonly providerType = "outlook" as const;

  constructor(
    private readonly accountId: string,
    private readonly email: string
  ) {}

  async sendEmail(_params: SendEmailParams): Promise<SendEmailResult> {
    // TODO (Phase 2): Implement via Microsoft Graph API
    // POST https://graph.microsoft.com/v1.0/me/sendMail
    throw new Error(
      "OutlookProvider.sendEmail is not yet implemented. This is an MVP stub."
    );
  }

  async validateConnection(): Promise<boolean> {
    // TODO (Phase 2): Validate via Microsoft Graph token refresh
    return false;
  }
}
