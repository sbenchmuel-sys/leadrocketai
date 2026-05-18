// ============================================================
// Subscription Health Check — cron every 12 hours
//
// For each Outlook mail_account:
//   - If we have ANY existing subscription row with a subscription_id,
//     try PATCH (renew) first — even if the row is currently flagged
//     as 'error'. PATCH does not trigger Graph's validation handshake,
//     so it's far more reliable than CREATE.
//   - Only fall through to CREATE if no row exists OR the PATCH returns
//     404 (Graph removed the subscription on its side).
//   - Tolerate transient failures via error_count: only after N
//     consecutive failures do we escalate mail_accounts.status to 'error'.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import {
  createOutlookSubscription,
  renewOutlookSubscription,
} from "../_shared/outlookSubscription.ts";
import { logger } from "../_shared/logger.ts";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Renew when subscription expires within 24 hours
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
// Only escalate mail_accounts.status='error' after this many consecutive
// failures. Keeps a single 502 from showing a red banner in the UI.
const ESCALATE_AFTER_FAILURES = 3;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  // AUTH: Only cron-dispatcher / service-role callers
  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

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

    for (const rawAccount of accounts ?? []) {
      const account = rawAccount as { id: string; email_address: string; status: string };
      try {
        const accessToken = await getFreshOutlookToken(account.id, serviceClient);

        // Pull the most recent subscription row regardless of status.
        // We want to try PATCH even on 'error' rows — PATCH is reliable
        // and may succeed where a prior CREATE failed.
        const { data: existingSubRaw } = await serviceClient
          .from("outlook_subscriptions")
          .select("id, subscription_id, expiration_at, status, error_count")
          .eq("mail_account_id", account.id)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const existingSub = existingSubRaw as
          | {
              id: string;
              subscription_id: string;
              expiration_at: string;
              status: string;
              error_count: number;
            }
          | null;

        const now = Date.now();

        // Skip only if the sub is healthy AND not within the renewal window.
        const isHealthy = existingSub?.status === "active";
        const isFarFromExpiry =
          existingSub &&
          new Date(existingSub.expiration_at).getTime() - now >= RENEWAL_WINDOW_MS;

        if (isHealthy && isFarFromExpiry) {
          results.push({ account_id: account.id, action: "skip", ok: true });
          continue;
        }

        // ── Try PATCH first if we have a real subscription_id ──
        // This is the safe, handshake-free path. Works for routine
        // renewals, retry-after-transient-error, and even attempts to
        // revive a sub we previously marked 'removed' (Graph may still
        // accept the PATCH if it hasn't actually expired their side yet).
        // `pending:` rows are local placeholders inserted by the catch
        // handler when CREATE has never succeeded — skipping PATCH on
        // those keeps CREATE in rotation every tick.
        const hasRealSubscription =
          !!existingSub?.subscription_id &&
          !existingSub.subscription_id.startsWith("pending:");

        if (hasRealSubscription && existingSub) {
          try {
            await renewOutlookSubscription(
              account.id,
              existingSub.subscription_id,
              existingSub.id,
              accessToken,
              serviceClient
            );
            results.push({ account_id: account.id, action: "renewed", ok: true });

            // Restore account status if it was in error
            if (account.status === "error") {
              await serviceClient
                .from("mail_accounts")
                .update({ status: "connected", error_reason: null, updated_at: new Date().toISOString() })
                .eq("id", account.id);
            }
            continue;
          } catch (patchErr) {
            const status = (patchErr as Error & { status?: number }).status;
            // 404 → subscription is genuinely gone on Graph's side.
            // Fall through to CREATE. Any other status → treat as transient.
            if (status !== 404) {
              throw patchErr;
            }
            logger.info("mail.outlook.subscription_patch_404_fallthrough", {
              mail_account_id: account.id,
              subscription_id: existingSub.subscription_id,
            });
            // Mark the dead row 'removed' before CREATE so we don't try
            // to PATCH this id again on the next run.
            await serviceClient
              .from("outlook_subscriptions")
              .update({
                status: "removed",
                error_reason: "Graph returned 404 on PATCH",
                updated_at: new Date().toISOString(),
              })
              .eq("id", existingSub.id);
          }
        }

        // ── CREATE path (no existing sub, or PATCH returned 404) ──
        await createOutlookSubscription(account.id, accessToken, serviceClient);
        results.push({ account_id: account.id, action: "created", ok: true });

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

        // Read current error_count (may have been bumped by a lifecycle event)
        // so escalation reflects truly consecutive failures.
        const { data: currentSubRaw } = await serviceClient
          .from("outlook_subscriptions")
          .select("id, error_count")
          .eq("mail_account_id", account.id)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const currentSub = currentSubRaw as { id: string; error_count: number } | null;
        const newErrorCount = (currentSub?.error_count ?? 0) + 1;
        const shouldEscalate = newErrorCount >= ESCALATE_AFTER_FAILURES;

        // Always bump the subscription row's error_count + reason.
        if (currentSub) {
          await serviceClient
            .from("outlook_subscriptions")
            .update({
              error_count: newErrorCount,
              error_reason: reason,
              // Only flip the sub row's status to 'error' once we've
              // crossed the escalation threshold, so a single transient
              // 502 doesn't take the sub out of contention for PATCH.
              ...(shouldEscalate ? { status: "error" } : {}),
              updated_at: new Date().toISOString(),
            })
            .eq("id", currentSub.id);
        } else {
          // CREATE has never produced a row for this account, so without
          // an INSERT here the counter resets to 1 on every cron tick and
          // we never escalate. Insert a placeholder row carrying the
          // running error_count; createOutlookSubscription's upsert
          // (onConflict: mail_account_id) will overwrite it cleanly when
          // CREATE eventually succeeds. The synthetic subscription_id is
          // never sent to Graph — PATCH against it returns 404, falling
          // through to CREATE on the next tick.
          await serviceClient
            .from("outlook_subscriptions")
            .insert({
              mail_account_id: account.id,
              subscription_id: `pending:${crypto.randomUUID()}`,
              expiration_at: new Date().toISOString(),
              status: shouldEscalate ? "error" : "active",
              error_count: newErrorCount,
              error_reason: reason,
            });
        }

        // Only flip mail_accounts.status to 'error' (the thing the UI
        // shows as a red banner) on sustained failure.
        if (shouldEscalate) {
          await serviceClient
            .from("mail_accounts")
            .update({ status: "error", error_reason: reason, updated_at: new Date().toISOString() })
            .eq("id", account.id);
        }

        results.push({
          account_id: account.id,
          action: shouldEscalate ? "error_escalated" : "error_tolerated",
          ok: false,
          error: reason,
        });
      }
    }

    logger.info("mail.outlook.subscription_check_complete", {
      total: results.length,
      renewed: results.filter((r) => r.action === "renewed").length,
      created: results.filter((r) => r.action === "created").length,
      tolerated: results.filter((r) => r.action === "error_tolerated").length,
      escalated: results.filter((r) => r.action === "error_escalated").length,
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

