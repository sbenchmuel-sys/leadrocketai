// ============================================================
// Subscription Health Check — runs every 6 hours via cron
//
// For each Outlook mail_account:
//   - If subscription missing OR expires_at < 12h → renew
//   - If renewal fails → mark account.status = "error", log reason
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { logger } from "../_shared/logger.ts";

const RENEWAL_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours
// Graph subscriptions max lifetime: 3 days for Mail
const SUBSCRIPTION_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;

serve(async (req) => {
  // Accept both cron (no auth) and manual calls (bearer auth)
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const notificationUrl = Deno.env.get("OUTLOOK_WEBHOOK_URL") ?? "";

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch all connected Outlook accounts
    const { data: accounts, error: acctErr } = await serviceClient
      .from("mail_accounts")
      .select("id, email_address, status")
      .eq("provider", "outlook")
      .in("status", ["connected", "error"]);

    if (acctErr) throw acctErr;

    const results: Array<{ account_id: string; action: string; ok: boolean; error?: string }> = [];

    for (const account of accounts ?? []) {
      try {
        const accessToken = await getFreshOutlookToken(account.id, serviceClient);

        // Check existing active subscription
        const { data: existingSub } = await serviceClient
          .from("outlook_subscriptions")
          .select("id, subscription_id, expiration_at")
          .eq("mail_account_id", account.id)
          .eq("status", "active")
          .maybeSingle();

        const now = Date.now();
        const needsRenewal =
          !existingSub ||
          new Date(existingSub.expiration_at).getTime() - now < RENEWAL_WINDOW_MS;

        if (!needsRenewal) {
          results.push({ account_id: account.id, action: "skip", ok: true });
          continue;
        }

        if (existingSub && notificationUrl) {
          // Renew existing subscription via PATCH
          const newExpiry = new Date(now + SUBSCRIPTION_LIFETIME_MS).toISOString();
          const renewResp = await fetch(
            `https://graph.microsoft.com/v1.0/subscriptions/${existingSub.subscription_id}`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ expirationDateTime: newExpiry }),
            }
          );

          if (!renewResp.ok) {
            const body = await renewResp.text();
            throw new Error(`Subscription PATCH failed (${renewResp.status}): ${body}`);
          }

          await serviceClient
            .from("outlook_subscriptions")
            .update({
              expiration_at: newExpiry,
              last_renewed_at: new Date().toISOString(),
              error_reason: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingSub.id);

          logger.info("mail.outlook.subscription_renewed", {
            mail_account_id: account.id,
            email: account.email_address,
            new_expiry: newExpiry,
          });

          results.push({ account_id: account.id, action: "renewed", ok: true });
        } else if (notificationUrl) {
          // Create new subscription
          const newExpiry = new Date(now + SUBSCRIPTION_LIFETIME_MS).toISOString();
          const clientState = crypto.randomUUID();

          const createResp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              changeType: "created",
              notificationUrl,
              resource: "me/mailFolders('Inbox')/messages",
              expirationDateTime: newExpiry,
              clientState,
            }),
          });

          if (!createResp.ok) {
            const body = await createResp.text();
            throw new Error(`Subscription CREATE failed (${createResp.status}): ${body}`);
          }

          const sub = await createResp.json();

          await serviceClient.from("outlook_subscriptions").insert({
            mail_account_id: account.id,
            subscription_id: sub.id,
            resource: sub.resource,
            change_types: [sub.changeType],
            expiration_at: sub.expirationDateTime,
            notification_url: notificationUrl,
            client_state: clientState,
            status: "active",
            last_renewed_at: new Date().toISOString(),
          });

          logger.info("mail.outlook.subscription_created", {
            mail_account_id: account.id,
            subscription_id: sub.id,
          });

          results.push({ account_id: account.id, action: "created", ok: true });
        } else {
          // No webhook URL configured — skip subscription management
          results.push({ account_id: account.id, action: "no_webhook_url", ok: true });
        }

        // Restore account to connected if it was in error
        if (account.status === "error") {
          await serviceClient
            .from("mail_accounts")
            .update({ status: "connected", error_reason: null, updated_at: new Date().toISOString() })
            .eq("id", account.id);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);

        logger.error("mail.outlook.subscription_failed", {
          mail_account_id: account.id,
          email: account.email_address,
          error: reason,
        });

        await serviceClient
          .from("mail_accounts")
          .update({
            status: "error",
            error_reason: reason,
            updated_at: new Date().toISOString(),
          })
          .eq("id", account.id);

        await serviceClient.from("outlook_subscriptions")
          .update({ status: "error", error_reason: reason, updated_at: new Date().toISOString() })
          .eq("mail_account_id", account.id)
          .eq("status", "active");

        results.push({ account_id: account.id, action: "error", ok: false, error: reason });
      }
    }

    logger.info("mail.outlook.subscription_check_complete", {
      total: results.length,
      errors: results.filter((r) => !r.ok).length,
    });

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const errorId = crypto.randomUUID();
    logger.error("mail.outlook.subscription_check_fatal", { error_id: errorId, error: String(err) });
    return new Response(JSON.stringify({ ok: false, error_id: errorId }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
