// ============================================================
// Shared helper: create or renew a Graph Mail subscription
// Used by: outlook-callback (on connect) and outlook-subscription-check (renewal)
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { logger } from "./logger.ts";

// Graph limits Mail subscriptions to 4230 minutes (~2.9 days). Use 2 days to be safe.
export const SUBSCRIPTION_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000;

export async function createOutlookSubscription(
  mailAccountId: string,
  accessToken: string,
  serviceClient: ReturnType<typeof createClient>
): Promise<{ subscriptionId: string; expiresAt: string }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  // Derive the webhook URL from the project URL
  const webhookUrl = `${supabaseUrl}/functions/v1/outlook-webhook`;
  const clientState = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();

  const resp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl: webhookUrl,
      resource: "/me/mailFolders('Inbox')/messages",
      expirationDateTime: expiresAt,
      clientState,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Graph subscription CREATE failed (${resp.status}): ${body}`);
  }

  const sub = await resp.json();

  // Upsert into outlook_subscriptions — one active sub per account
  await serviceClient
    .from("outlook_subscriptions")
    .upsert(
      {
        mail_account_id: mailAccountId,
        subscription_id: sub.id,
        resource: sub.resource ?? "/me/mailFolders('Inbox')/messages",
        change_types: ["created"],
        expiration_at: sub.expirationDateTime ?? expiresAt,
        notification_url: webhookUrl,
        client_state: clientState,
        status: "active",
        last_renewed_at: new Date().toISOString(),
        error_reason: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "mail_account_id" }
    );

  logger.info("mail.outlook.subscription_created", {
    mail_account_id: mailAccountId,
    subscription_id: sub.id,
    expires_at: sub.expirationDateTime,
  });

  return { subscriptionId: sub.id, expiresAt: sub.expirationDateTime ?? expiresAt };
}

export async function renewOutlookSubscription(
  mailAccountId: string,
  subscriptionId: string,
  subscriptionRowId: string,
  accessToken: string,
  serviceClient: ReturnType<typeof createClient>
): Promise<string> {
  const newExpiry = new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expirationDateTime: newExpiry }),
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Graph subscription PATCH failed (${resp.status}): ${body}`);
  }

  await serviceClient
    .from("outlook_subscriptions")
    .update({
      expiration_at: newExpiry,
      last_renewed_at: new Date().toISOString(),
      error_reason: null,
      status: "active",
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriptionRowId);

  logger.info("mail.outlook.subscription_renewed", {
    mail_account_id: mailAccountId,
    subscription_id: subscriptionId,
    new_expiry: newExpiry,
  });

  return newExpiry;
}
