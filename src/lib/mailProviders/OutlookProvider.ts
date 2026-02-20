// ============================================================
// OutlookProvider — delegates to outlook-send edge function
// Token refresh is handled inside the edge function via
// the getFreshOutlookToken middleware.
// ============================================================

import { supabase } from "@/integrations/supabase/client";
import type { IMailProvider, SendEmailParams, SendEmailResult } from "./types";

export class OutlookProvider implements IMailProvider {
  readonly providerType = "outlook" as const;

  constructor(
    private readonly accountId: string,
    private readonly email: string
  ) {}

  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const { data, error } = await supabase.functions.invoke("outlook-send", {
      body: {
        mail_account_id: this.accountId,
        to: params.to,
        subject: params.subject,
        bodyHtml: params.bodyHtml,
        threadId: params.threadId ?? null,
      },
    });

    if (error) {
      throw new Error(`OutlookProvider.sendEmail failed: ${error.message}`);
    }

    if (!data?.ok) {
      throw new Error(
        `OutlookProvider.sendEmail: ${data?.error ?? "Unknown error"} (error_id: ${data?.error_id ?? "n/a"})`
      );
    }

    return {
      messageId: data?.messageId ?? "",
      threadId: params.threadId,
    };
  }

  async validateConnection(): Promise<boolean> {
    // Delegate to health endpoint — just check account status in DB
    const { data } = await supabase
      .from("mail_accounts")
      .select("status, token_expires_at")
      .eq("id", this.accountId)
      .eq("provider", "outlook")
      .single();

    if (!data) return false;
    if (data.status !== "connected") return false;
    if (!data.token_expires_at) return false;
    return new Date(data.token_expires_at) > new Date();
  }
}
