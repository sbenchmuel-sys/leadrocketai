// ============================================================
// Outlook Token Auto-Refresh Middleware
//
// Before every Graph API call:
//   - Check if token expires within 5 minutes
//   - If so, refresh automatically
//   - If refresh fails → mark account as expired + log event
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { encryptToken, safeDecryptToken } from "./encryption.ts";
import { logger } from "./logger.ts";
import { OutlookGraphClient, MicrosoftCredentialsMissingError } from "./outlookGraphClient.ts";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export interface OutlookTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * Returns a fresh access token for the given mail_account_id.
 * Refreshes automatically if within 5-minute expiry window.
 * Throws if refresh fails (and marks account as expired).
 */
export async function getFreshOutlookToken(
  mailAccountId: string,
  serviceSupabase: ReturnType<typeof createClient>
): Promise<string> {
  const { data: account, error } = await serviceSupabase
    .from("mail_accounts")
    .select("id, email_address, access_token, refresh_token, token_expires_at, status")
    .eq("id", mailAccountId)
    .eq("provider", "outlook")
    .single();

  if (error || !account) {
    throw new Error(`[outlook-tokens] mail_account ${mailAccountId} not found`);
  }

  if (account.status === "expired") {
    throw new Error(`[outlook-tokens] mail_account ${mailAccountId} is expired — reauthorize required`);
  }

  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at) : new Date(0);
  const needsRefresh = expiresAt.getTime() - Date.now() < TOKEN_EXPIRY_BUFFER_MS;

  if (!needsRefresh) {
    // Token still valid — decrypt and return
    return safeDecryptToken(account.access_token ?? "");
  }

  // --- Refresh path ---
  logger.info("mail.outlook.token_refresh_attempt", { mail_account_id: mailAccountId });

  try {
    const refreshTokenValue = await safeDecryptToken(account.refresh_token ?? "");

    // Throws MicrosoftCredentialsMissingError if env vars absent — bubbles up safely
    const tokens = await OutlookGraphClient.refreshToken(
      refreshTokenValue,
      "Mail.Read Mail.ReadWrite Mail.Send offline_access User.Read"
    );

    const newAccessToken: string = tokens.access_token;
    const newRefreshToken: string = tokens.refresh_token ?? refreshTokenValue;
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Encrypt and persist
    const hasKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
    const [encAccess, encRefresh] = await Promise.all([
      hasKey ? encryptToken(newAccessToken) : Promise.resolve(newAccessToken),
      hasKey ? encryptToken(newRefreshToken) : Promise.resolve(newRefreshToken),
    ]);

    await serviceSupabase
      .from("mail_accounts")
      .update({
        access_token: encAccess,
        refresh_token: encRefresh,
        token_expires_at: newExpiresAt.toISOString(),
        status: "connected",
        error_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mailAccountId);

    logger.info("mail.outlook.token_refreshed", {
      mail_account_id: mailAccountId,
      email: account.email_address,
      new_expires_at: newExpiresAt.toISOString(),
    });

    return newAccessToken;
  } catch (err) {
    // Refresh failed — mark account expired
    const errorReason = err instanceof Error ? err.message : String(err);

    logger.error("mail.outlook.token_refresh_failed", {
      mail_account_id: mailAccountId,
      email: account.email_address,
      error: errorReason,
    });

    await serviceSupabase
      .from("mail_accounts")
      .update({
        status: "expired",
        error_reason: errorReason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mailAccountId);

    // Emit domain event for downstream consumers
    logger.error("mail.account.expired", {
      mail_account_id: mailAccountId,
      email: account.email_address,
      reason: errorReason,
    });

    throw new Error(`Outlook token refresh failed for account ${mailAccountId}: ${errorReason}`);
  }
}
