// ============================================================
// Mail Provider Types — shared across Gmail + Outlook
// ============================================================

export type MailProviderType = "gmail" | "outlook";

export type MailAccountStatus = "connected" | "expired" | "error";

/** Row shape returned from the mail_accounts table */
export interface MailAccount {
  id: string;
  workspace_id: string;
  provider: MailProviderType;
  email_address: string;
  display_name: string;
  external_user_id: string | null;
  status: MailAccountStatus;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Provider Interface — implemented by GmailProvider, OutlookProvider
// ============================================================

export interface SendEmailParams {
  to: string;
  subject: string;
  bodyHtml: string;
  threadId?: string;
  fromName?: string;
}

export interface SendEmailResult {
  messageId: string;
  threadId?: string;
}

export interface IMailProvider {
  readonly providerType: MailProviderType;

  /** Send an email using this provider's credentials */
  sendEmail(params: SendEmailParams): Promise<SendEmailResult>;

  /** Check if the account credentials are still valid */
  validateConnection(): Promise<boolean>;
}
