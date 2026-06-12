// ============================================================
// Outlook Token Auto-Refresh Middleware
//
// Before every Graph API call:
//   - Check if token expires within 5 minutes
//   - If so, refresh automatically
//   - If refresh fails → mark account as expired + log event
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { assertEncryptionConfigured, encryptToken, safeDecryptToken } from "./encryption.ts";
import { logger } from "./logger.ts";
import { OutlookGraphClient, MicrosoftCredentialsMissingError } from "./outlookGraphClient.ts";
import {
  OUTLOOK_MAIL_SCOPES_STRING,
  extractTenantIdFromAccessToken,
} from "./outlookScopes.ts";

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
 *
 * `scopes` is the space-delimited scope string sent on refresh.
 * Defaults to `OUTLOOK_MAIL_SCOPES_STRING` (back-compat with all
 * pre-existing callers). Override with a wider bundle (e.g.
 * `OUTLOOK_FULL_OAUTH_SCOPES_STRING`) when the caller needs a
 * non-mail scope such as `OnlineMeetingTranscript.Read.All`.
 *
 * Microsoft's refresh endpoint rejects scopes outside the user's
 * original grant — so the override must still be a subset of what
 * the user originally consented to.
 */
export async function getFreshOutlookToken(
  mailAccountId: string,
  serviceSupabase: ReturnType<typeof createClient>,
  scopes: string = OUTLOOK_MAIL_SCOPES_STRING
): Promise<string> {
  const { data: account, error } = await serviceSupabase
    .from("mail_accounts")
    .select("id, email_address, access_token, refresh_token, token_expires_at, status, tenant_id")
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
  // Fail closed BEFORE the try/catch below: a missing TOKEN_ENCRYPTION_KEY is
  // a config error, not an auth failure — it must not mark the account
  // expired, and plaintext tokens are never stored.
  assertEncryptionConfigured();

  logger.info("mail.outlook.token_refresh_attempt", { mail_account_id: mailAccountId });

  try {
    const refreshTokenValue = await safeDecryptToken(account.refresh_token ?? "");

    // Throws MicrosoftCredentialsMissingError if env vars absent — bubbles up safely
    const tokens = await OutlookGraphClient.refreshToken(
      refreshTokenValue,
      scopes
    );

    const newAccessToken: string = tokens.access_token;
    const newRefreshToken: string = tokens.refresh_token ?? refreshTokenValue;
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Encrypt and persist — never plaintext (key presence asserted above)
    const [encAccess, encRefresh] = await Promise.all([
      encryptToken(newAccessToken),
      encryptToken(newRefreshToken),
    ]);

    // Backfill tenant_id for accounts connected before the column existed —
    // lets the frontend reconsent hook stop nudging existing personal-account
    // users without forcing them to disconnect/reconnect.
    const existingTenantId = (account as { tenant_id?: string | null }).tenant_id ?? null;
    const refreshedTenantId =
      existingTenantId ?? extractTenantIdFromAccessToken(newAccessToken);

    await serviceSupabase
      .from("mail_accounts")
      .update({
        access_token: encAccess,
        refresh_token: encRefresh,
        token_expires_at: newExpiresAt.toISOString(),
        status: "connected",
        error_reason: null,
        ...(refreshedTenantId && !existingTenantId ? { tenant_id: refreshedTenantId } : {}),
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
