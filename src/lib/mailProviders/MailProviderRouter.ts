// ============================================================
// MailProviderRouter
//
// Two public functions:
//   getDefaultMailAccount(workspace_id) — resolves which account to use
//   getProvider(mail_account_id)        — returns the correct IMailProvider
// ============================================================

import { supabase } from "@/integrations/supabase/client";
import { GmailProvider } from "./GmailProvider";
import { OutlookProvider } from "./OutlookProvider";
import type { IMailProvider, MailAccount } from "./types";

// ============================================================
// getDefaultMailAccount
// Priority:
//   1. mail_accounts row where is_default = true for workspace
//   2. First Gmail account for workspace if no default set
// ============================================================

export async function getDefaultMailAccount(
  workspaceId: string
): Promise<MailAccount | null> {
  // Try explicit default first
  const { data: defaultAccount } = await supabase
    .from("mail_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .eq("status", "connected")
    .maybeSingle();

  if (defaultAccount) return defaultAccount as MailAccount;

  // Fallback: first connected Gmail account for workspace
  const { data: fallback } = await supabase
    .from("mail_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("provider", "gmail")
    .eq("status", "connected")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return (fallback as MailAccount | null) ?? null;
}

// ============================================================
// getProvider
// Resolves a mail_account_id → concrete IMailProvider.
// If mail_account_id is null/undefined, caller should first
// resolve via getDefaultMailAccount.
// ============================================================

export async function getProvider(
  mailAccountId: string
): Promise<IMailProvider> {
  const { data: account, error } = await supabase
    .from("mail_accounts")
    .select("*")
    .eq("id", mailAccountId)
    .single();

  if (error || !account) {
    throw new Error(
      `MailProviderRouter: mail account ${mailAccountId} not found`
    );
  }

  const ma = account as MailAccount;

  switch (ma.provider) {
    case "gmail": {
      // Resolve the user_id from gmail_connections via email_address
      const { data: gmailConn } = await supabase
        .from("gmail_connections")
        .select("user_id")
        .eq("gmail_email", ma.email_address)
        .maybeSingle();

      return new GmailProvider(
        gmailConn?.user_id ?? "",
        ma.email_address
      );
    }

    case "outlook":
      return new OutlookProvider(ma.id, ma.email_address);

    default:
      throw new Error(
        `MailProviderRouter: unknown provider "${(ma as any).provider}"`
      );
  }
}

// ============================================================
// Convenience: resolve provider with automatic fallback
// ============================================================

export async function resolveProvider(
  mailAccountId: string | null | undefined,
  workspaceId: string
): Promise<IMailProvider> {
  if (mailAccountId) {
    return getProvider(mailAccountId);
  }

  // Fallback to workspace default
  const defaultAccount = await getDefaultMailAccount(workspaceId);
  if (!defaultAccount) {
    throw new Error(
      `MailProviderRouter: no mail account found for workspace ${workspaceId}`
    );
  }
  return getProvider(defaultAccount.id);
}
