// scout-enrich — approve Lead Scout suggestions: enrich, then create the lead.
//
// Callers: the Pending tab (user JWT; membership + scout_enabled via
// openScoutRequest) and scout-weekly-run's auto-approve (service role /
// X-Internal-Secret; scout_enabled still checked).
// Body: { workspace_id, candidate_ids: string[] | candidate_id: string } (max 100).
//
// Only rows in that workspace with source='ai_scout' AND status='pending' are
// touched, and each is claimed first with a conditional UPDATE (pending →
// approved … RETURNING) so double clicks / concurrent Approve-alls never
// enrich (= pay for) the same person twice. Order + credit rules live in
// _shared/scoutEnrich.ts. One scout_runs row (kind='enrich') per call with the
// credits spent. Leads are created with the service role; nothing is sent
// and nobody is enrolled in a cadence.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isInternalCaller, isServiceRoleToken } from "../_shared/authz.ts";
import { apolloEnrichPerson, lushaPhone } from "../_shared/prospectProviders.ts";
import {
  type BatchInfo, countResolvedBatches, type EnrichIO, normalizeEnrichIds, runEnrich, type ScoutCandidateRow,
} from "../_shared/scoutEnrich.ts";
import {
  type AdminClient, loadEnrichFilterContext, openScoutRequest, readScoutSettings, scoutCors, scoutJson,
} from "../_shared/scoutGate.ts";

const CANDIDATE_COLS =
  "id, workspace_id, owner_user_id, contact_name, company_domain, company_name, job_title, linkedin_url, location, ai_reason, fit_label, scout_batch_id, anchor_lead_id, provider, provider_person_id";

interface Ctx {
  admin: AdminClient;
  workspaceId: string;
  body: Record<string, unknown>;
  allowEu: boolean;
}

async function open(req: Request): Promise<Ctx | Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: scoutCors });
  if (isInternalCaller(req) || isServiceRoleToken(req)) {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.workspace_id !== "string") return scoutJson({ ok: false, error: "workspace_id is required" }, 400);
    const admin: AdminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const settings = await readScoutSettings(admin, body.workspace_id);
    if (!settings) return scoutJson({ ok: false, reason: "not_enabled" });
    return { admin, workspaceId: body.workspace_id, body, allowEu: settings.scout_allow_eu };
  }
  const r = await openScoutRequest(req);
  if (r instanceof Response) return r;
  return { admin: r.admin, workspaceId: r.workspaceId, body: r.body, allowEu: r.settings.scout_allow_eu };
}

Deno.serve(async (req) => {
  const ctx = await open(req);
  if (ctx instanceof Response) return ctx;
  const { admin, workspaceId } = ctx;

  const ids = normalizeEnrichIds(ctx.body.candidate_ids ?? ctx.body.candidate_id);
  if (!ids.length) return scoutJson({ ok: false, error: "candidate_ids is required" }, 400);

  const apolloKey = Deno.env.get("APOLLO_API_KEY");
  if (!apolloKey) {
    console.log("scout: no provider key, skipping");
    return scoutJson({ ok: false, reason: "no_provider_key" });
  }
  const lushaKey = Deno.env.get("LUSHA_API_KEY");

  const startedAt = new Date().toISOString();
  const io: EnrichIO = {
    claim: async (claimIds) => {
      const { data, error } = await admin
        .from("lead_candidates")
        .update({ status: "approved", resolved_at: new Date().toISOString() })
        .in("id", claimIds)
        .eq("workspace_id", workspaceId)
        .eq("source", "ai_scout")
        .eq("status", "pending")
        .select(CANDIDATE_COLS);
      if (error) throw new Error(`claim: ${error.message}`);
      return (data ?? []) as ScoutCandidateRow[];
    },
    batchInfo: async (batchIds) => {
      const out = new Map<string, BatchInfo>();
      if (!batchIds.length) return out;
      const { data: runs } = await admin
        .from("scout_runs").select("id, profile_id").in("id", batchIds).eq("workspace_id", workspaceId);
      const profileIds = [...new Set(((runs ?? []) as Array<{ profile_id: string | null }>).map((r) => r.profile_id).filter(Boolean))];
      const { data: profiles } = profileIds.length
        ? await admin.from("scout_profiles").select("id, profile_sentence").in("id", profileIds)
        : { data: [] };
      const sentence = new Map(((profiles ?? []) as Array<{ id: string; profile_sentence: string | null }>).map((p) => [p.id, p.profile_sentence]));
      for (const r of (runs ?? []) as Array<{ id: string; profile_id: string | null }>) {
        out.set(r.id, { profile_id: r.profile_id, profile_sentence: r.profile_id ? sentence.get(r.profile_id) ?? null : null });
      }
      return out;
    },
    createLead: async (payload) => {
      const { data, error } = await admin.from("leads").insert(payload).select("id").single();
      if (error?.code === "23505") return { duplicate: true };
      if (error || !data?.id) return { error: `lead insert: ${error?.message ?? "no row"}` };
      return { id: data.id as string };
    },
    update: async (id, patch) => {
      const { error } = await admin.from("lead_candidates").update(patch).eq("id", id).eq("workspace_id", workspaceId);
      if (error) throw new Error(`candidate update: ${error.message}`);
    },
  };

  try {
    const sum = await runEnrich(ids, io, {
      apollo: (c) => apolloEnrichPerson({ fetch, apiKey: apolloKey }, c),
      lusha: lushaKey ? (s) => lushaPhone({ fetch, apiKey: lushaKey }, s) : null,
      loadFilterContext: (q) => loadEnrichFilterContext(admin, workspaceId, ctx.allowEu, q),
      now: () => new Date(),
    });

    if (sum.claimed > 0) {
      await admin.from("scout_runs").insert({
        workspace_id: workspaceId,
        profile_id: null,
        kind: "enrich",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        candidates_found: sum.claimed,
        candidates_kept: sum.added,
        apollo_credits: sum.apollo_credits,
        lusha_credits: sum.lusha_credits,
        error: sum.errors.length ? sum.errors.slice(0, 3).join("; ").slice(0, 300) : null,
      });
      await countResolvedBatches(admin, workspaceId, sum.batch_ids);
      // Same follow-up as PendingLeadsTab.createLeadFromCandidate: intelligence
      // recompute so motion / next action are right. No mail backfill — a scout
      // prospect passed the existing-lead filter, so there's no thread to pull.
      background(Promise.allSettled(sum.lead_ids.map(recompute)));
    }
    return scoutJson({
      ok: true,
      added: sum.added,
      skipped_no_email: sum.skipped_no_email,
      skipped_other: sum.skipped_other,
      retry: sum.retry,
      lead_ids: sum.lead_ids,
    });
  } catch (e) {
    console.error("[scout-enrich] error:", e instanceof Error ? e.message : e);
    return scoutJson({ ok: false, error: "Internal error" }, 500);
  }
});

function recompute(leadId: string) {
  return fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/recompute-lead-intelligence`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      "X-Internal-Secret": Deno.env.get("INTERNAL_API_SECRET") ?? "",
    },
    body: JSON.stringify({ lead_id: leadId, force: true }),
  }).then((r) => r.body?.cancel());
}

function background(p: Promise<unknown>) {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(p);
}
