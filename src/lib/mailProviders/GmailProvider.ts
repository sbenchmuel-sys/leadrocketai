// ============================================================
// GmailProvider — thin wrapper, delegates to existing gmail-send edge function
// ============================================================

import { supabase } from "@/integrations/supabase/client";
import type { IMailProvider, SendEmailParams, SendEmailResult } from "./types";

export class GmailProvider implements IMailProvider {
  readonly providerType = "gmail" as const;

  constructor(
    private readonly userId: string,
    private readonly gmailEmail: string
  ) {}

  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const { data, error } = await supabase.functions.invoke("gmail-send", {
      body: {
        to: params.to,
        subject: params.subject,
        body: params.bodyHtml,
        threadId: params.threadId ?? null,
        fromName: params.fromName ?? null,
      },
    });

    if (error) throw new Error(`GmailProvider.sendEmail failed: ${error.message}`);

    return {
      messageId: data?.messageId ?? "",
      threadId: data?.threadId ?? undefined,
    };
  }

  async validateConnection(): Promise<boolean> {
    const { data } = await supabase
      .from("gmail_connections")
      .select("id, token_expires_at")
      .eq("gmail_email", this.gmailEmail)
      .single();

    if (!data) return false;
    return new Date(data.token_expires_at) > new Date();
  }
}
