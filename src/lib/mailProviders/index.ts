// Public barrel export for mail provider system
export type { IMailProvider, MailAccount, MailProviderType, MailAccountStatus, SendEmailParams, SendEmailResult } from "./types";
export { GmailProvider } from "./GmailProvider";
export { OutlookProvider } from "./OutlookProvider";
export { getDefaultMailAccount, getProvider, resolveProvider } from "./MailProviderRouter";
