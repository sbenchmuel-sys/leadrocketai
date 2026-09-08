// ============================================================
// outlook-followup-sweep — the periodic recompute Outlook never had
//
// THE HOLE (Queue audit P1, second half): `deriveAction` only runs when
// something triggers it. Gmail has `gmail-bulk-sync` on a cron, which walks
// EVERY lead of a connection and re-derives it, so a quiet Gmail lead
// eventually surfaces as `followup_due`. Outlook has no such job: `outlook-sync`
// runs only from the UI and only touches leads with new messages, and the
// post-send recompute (Unit Q1) fires seconds after the send, when the 3/5-day
// wait obviously has not expired and the correct answer is "nothing to do".
// Nothing ever looks again — so an unanswered Outlook message never returns to
// the Queue, which is the exact failure this unit exists to fix.
//
// This job re-derives the leads that could have become due since their last
// write, through `recomputeLeadAction` — the SAME code path a send uses, so
// there is one rule in one place and no second copy of it to drift.
//
// SAFETY: it computes and persists only. `deriveAction` cannot emit a send key
// for these leads (`followup_due` / `rate_limited` are prompts, absent from
// OUTBOUND_SEND_KEYS), and `buildLeadUpdate` blanks their `eligible_at`, so a
// swept lead can never match `automation-executor`'s candidate query. Leads
// with an armed cadence keep their anchor untouched. This job sends nothing and
// arms nothing.
//
// SCOPE: workspaces with a connected Outlook mail account. Gmail workspaces are
// already covered by their bulk-sync cron, and sweeping them here would double
// that work daily for no gain. A workspace on both is swept by both; the
// recompute is idempotent, so that is harmless.
//
// ponytail: one page of candidates per run (SWEEP_LEAD_LIMIT), oldest-quiet
// first, no cursor. The candidate set is self-draining — a lead that surfaces
// gets `needs_action = true` and drops out — so at pilot scale one page is the
// whole set. Upgrade path when a workspace outgrows it: the cursor/paging shape
// gmail-bulk-sync already uses (`.order("id").gt("id", cursor)`).
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";
import { recomputeLeadAction } from "../_shared/postSendDeriveAction.ts";
import {
  followupSweepCutoffIso,
  isFollowupSweepCandidate,
  SWEEP_MIN_QUIET_DAYS,
} from "../_shared/followupRule.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Max leads re-derived per run. Each costs ~5 reads + 1 write. */
const SWEEP_LEAD_LIMIT = 200;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  // AUTH: cron-dispatcher (X-Internal-Secret) or service-role only.
  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const startedAt = Date.now();
  try {
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Workspaces with a live Outlook mailbox.
    const { data: accounts, error: acctErr } = await serviceClient
      .from("mail_accounts")
      .select("workspace_id")
      .eq("provider", "outlook")
      .eq("status", "connected");
    if (acctErr) throw acctErr;

    const workspaceIds = [
      ...new Set(
        (accounts ?? [])
          .map((a) => (a as { workspace_id?: string }).workspace_id)
          .filter((id): id is string => !!id),
      ),
    ];

    if (workspaceIds.length === 0) {
      logger.info("followup_sweep.no_outlook_workspaces", {});
      return json({ ok: true, workspaces: 0, candidates: 0, recomputed: 0 });
    }

    // 2. Candidate leads. The SQL is the coarse cut; `isFollowupSweepCandidate`
    // re-checks every row in memory so the two filters can't silently drift
    // (the in-memory one is what `src/test/followupRule.test.ts` pins).
    const cutoff = followupSweepCutoffIso(Date.now(), SWEEP_MIN_QUIET_DAYS);
    const { data: leads, error: leadsErr } = await serviceClient
      .from("leads")
      .select(
        "id, needs_action, last_outbound_at, last_inbound_at, unsubscribed, status, action_permanently_dismissed, action_dismissed_at",
      )
      .in("workspace_id", workspaceIds)
      .eq("needs_action", false)
      .eq("unsubscribed", false)
      .in("status", ["active", "new"])
      .is("action_dismissed_at", null)
      .not("last_outbound_at", "is", null)
      .lt("last_outbound_at", cutoff)
      .order("last_outbound_at", { ascending: true })
      .limit(SWEEP_LEAD_LIMIT);
    if (leadsErr) throw leadsErr;

    const candidates = (leads ?? []).filter((l) =>
      isFollowupSweepCandidate(l as Parameters<typeof isFollowupSweepCandidate>[0])
    );

    // 3. Re-derive. One lead's failure must not abort the sweep.
    let recomputed = 0;
    let failed = 0;
    for (const lead of candidates) {
      const leadId = (lead as { id: string }).id;
      try {
        await recomputeLeadAction(serviceClient, leadId, "[outlook-followup-sweep]");
        recomputed++;
      } catch (err) {
        failed++;
        logger.warn("followup_sweep.lead_failed", {
          lead_id: leadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("followup_sweep.done", {
      workspaces: workspaceIds.length,
      scanned: (leads ?? []).length,
      candidates: candidates.length,
      recomputed,
      failed,
      truncated: (leads ?? []).length >= SWEEP_LEAD_LIMIT,
      duration_ms: Date.now() - startedAt,
    });

    return json({
      ok: true,
      workspaces: workspaceIds.length,
      scanned: (leads ?? []).length,
      candidates: candidates.length,
      recomputed,
      failed,
      truncated: (leads ?? []).length >= SWEEP_LEAD_LIMIT,
    });
  } catch (err) {
    logger.error("followup_sweep.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
