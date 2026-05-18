// ============================================================
// Shared helper: create or renew a Graph Mail subscription
// Used by: outlook-callback (on connect) and outlook-subscription-check (renewal)
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { logger } from "./logger.ts";

// Graph limits Mail subscriptions to 4230 minutes (~2.9 days). Use 2 days to be safe.
export const SUBSCRIPTION_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000;

// Concurrent warmup pings before the Graph validation handshake.
// Supabase Edge routes incoming requests across multiple isolates,
// so a single sequential warmup may not warm the isolate Graph hits.
const WARMUP_FANOUT = 4;
// Pause after warmup so the isolate fully settles before Graph's POST.
const WARMUP_SETTLE_MS = 1200;

function webhookUrl(): string {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  return `${supabaseUrl}/functions/v1/outlook-webhook`;
}

// Fire several concurrent warmups so at least one isolate is hot
// when Graph performs the validation POST.
async function warmupWebhook(): Promise<void> {
  const url = webhookUrl();
  await Promise.allSettled(
    Array.from({ length: WARMUP_FANOUT }, () =>
      fetch(`${url}?validationToken=warmup`, { method: "GET" }).catch(() => {})
    )
  );
  await new Promise((r) => setTimeout(r, WARMUP_SETTLE_MS));
}

export async function createOutlookSubscription(
  mailAccountId: string,
  accessToken: string,
  serviceClient: ReturnType<typeof createClient>
): Promise<{ subscriptionId: string; expiresAt: string }> {
  const url = webhookUrl();
  const clientState = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();

  // Warm the webhook isolate(s) so Graph's validation POST (10s timeout)
  // doesn't land on a cold start and return BadGateway.
  await warmupWebhook();

  // Retry CREATE up to 3 times — Graph occasionally fails the validation
  // handshake on the first attempt even after warmup. Re-warm before each retry.
  let resp: Response | null = null;
  let lastBody = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    resp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        changeType: "created",
        notificationUrl: url,
        // Same endpoint receives lifecycle events (reauthorizationRequired,
        // subscriptionRemoved, missed). Without this, Graph silently
        // deactivates subs when reauth is needed — we never hear about it
        // until the next cron tries to renew, by which time it's too late.
        lifecycleNotificationUrl: url,
        resource: "/me/mailFolders('Inbox')/messages",
        expirationDateTime: expiresAt,
        clientState,
      }),
    });

    if (resp.ok) break;
    lastBody = await resp.text();
    logger.warn("mail.outlook.subscription_create_retry", {
      mail_account_id: mailAccountId,
      attempt,
      status: resp.status,
      body: lastBody.slice(0, 300),
    });
    if (attempt < 3) {
      // Re-warm before the next retry — the isolate may have died off in between.
      await warmupWebhook();
    }
  }

  if (!resp || !resp.ok) {
    throw new Error(`Graph subscription CREATE failed (${resp?.status ?? "no-resp"}): ${lastBody}`);
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
        notification_url: url,
        client_state: clientState,
        status: "active",
        last_renewed_at: new Date().toISOString(),
        error_reason: null,
        error_count: 0,
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
      // Only extending expirationDateTime — adding lifecycleNotificationUrl
      // or notificationUrl to a PATCH would re-trigger Graph's validation
      // handshake, which is the whole class of failure we're avoiding.
      body: JSON.stringify({ expirationDateTime: newExpiry }),
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    // Tag 404 so callers can distinguish "subscription gone" from transient errors
    const err = new Error(`Graph subscription PATCH failed (${resp.status}): ${body}`);
    (err as Error & { status?: number }).status = resp.status;
    throw err;
  }

  await serviceClient
    .from("outlook_subscriptions")
    .update({
      expiration_at: newExpiry,
      last_renewed_at: new Date().toISOString(),
      error_reason: null,
      error_count: 0,
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
