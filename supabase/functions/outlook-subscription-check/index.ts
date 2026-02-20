// ============================================================
// Subscription Health Check — cron every 12 hours
//
// For each Outlook mail_account:
//   - If subscription missing OR expires_at < 24h → renew
//   - If renewal fails → mark account.status = "error", log reason
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import {
  createOutlookSubscription,
  renewOutlookSubscription,
  SUBSCRIPTION_LIFETIME_MS,
} from "../_shared/outlookSubscription.ts";
import { logger } from "../_shared/logger.ts";

// Renew when subscription expires within 24 hours
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // All connected + error Outlook accounts
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

        if (existingSub) {
          // Renew via PATCH
          await renewOutlookSubscription(
            account.id,
            existingSub.subscription_id,
            existingSub.id,
            accessToken,
            serviceClient
          );
          results.push({ account_id: account.id, action: "renewed", ok: true });
        } else {
          // Create fresh subscription
          await createOutlookSubscription(account.id, accessToken, serviceClient);
          results.push({ account_id: account.id, action: "created", ok: true });
        }

        // Restore account status if it was in error
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

        await Promise.all([
          serviceClient
            .from("mail_accounts")
            .update({ status: "error", error_reason: reason, updated_at: new Date().toISOString() })
            .eq("id", account.id),
          serviceClient
            .from("outlook_subscriptions")
            .update({ status: "error", error_reason: reason, updated_at: new Date().toISOString() })
            .eq("mail_account_id", account.id)
            .eq("status", "active"),
        ]);

        results.push({ account_id: account.id, action: "error", ok: false, error: reason });
      }
    }

    logger.info("mail.outlook.subscription_check_complete", {
      total: results.length,
      renewed: results.filter((r) => r.action === "renewed").length,
      created: results.filter((r) => r.action === "created").length,
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
