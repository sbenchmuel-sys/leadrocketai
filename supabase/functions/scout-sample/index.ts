// scout-sample — Lead Scout setup, step 2: 5 real sample people to 👍/👎.
//
// Apollo People API Search only (free: 0 credits, no email/phone, obfuscated
// surname) → scoutFilters → ai_task (scout_pick_samples) picks 5 + a one-line
// reason each. Nothing is enriched or saved as a lead. One scout_runs row
// (kind='sample') per call, which is also the rate limit: 10 per rep per hour.
// No APOLLO_API_KEY → { ok:false, reason:"no_provider_key" } (clean no-op).
// No-op unless workspace_automation_settings.scout_enabled.
import { apolloSearchPeople } from "../_shared/prospectProviders.ts";
import { EU_UK_EEA_COUNTRIES, filterScoutCandidates } from "../_shared/scoutFilters.ts";
import { callScoutAi, openScoutRequest, ownedProfileId, scoutJson, type ScoutRequest } from "../_shared/scoutGate.ts";
import { clampProfile, parseSamplePicks, sampleRateLimit, toApolloFilters } from "../_shared/scoutProfile.ts";

/** This rep's kind='sample' runs in the last hour, across all their profiles. */
async function recentSampleRuns(r: ScoutRequest): Promise<number> {
  const { data: profiles } = await r.admin
    .from("scout_profiles").select("id").eq("workspace_id", r.workspaceId).eq("owner_user_id", r.userId);
  const ids = (profiles ?? []).map((p: { id: string }) => p.id);
  if (ids.length === 0) return 0;
  const { count } = await r.admin
    .from("scout_runs").select("id", { count: "exact", head: true })
    .eq("kind", "sample").in("profile_id", ids)
    .gte("started_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
  return count ?? 0;
}

/**
 * Drop lists that can bite BEFORE enrichment. ponytail: search stubs have no
 * email, LinkedIn or real surname, so the lead/unsubscribe/suppressed-email
 * rules can't match yet — Unit 3 re-runs the full filter after enrichment.
 */
async function filterContext(r: ScoutRequest) {
  const ws = r.workspaceId;
  const [sup, dis, internal, existing] = await Promise.all([
    r.admin.from("campaign_suppression_list").select("kind, value").eq("workspace_id", ws).eq("kind", "domain"),
    r.admin.from("workspace_dismissed_domains").select("domain").eq("workspace_id", ws),
    r.admin.from("workspace_internal_domains").select("domain").eq("workspace_id", ws),
    r.admin.from("lead_candidates").select("provider, provider_person_id").eq("workspace_id", ws).eq("source", "ai_scout"),
  ]);
  return {
    leads: [],
    unsubscribedEmails: [],
    suppressedEmails: [],
    suppressedDomains: (sup.data ?? []).map((x: { value: string }) => x.value),
    dismissedEmails: [],
    dismissedDomains: (dis.data ?? []).map((x: { domain: string }) => x.domain),
    internalDomains: (internal.data ?? []).map((x: { domain: string }) => x.domain),
    existingScoutCandidates: existing.data ?? [],
    allowEu: r.settings.scout_allow_eu,
  };
}

Deno.serve(async (req) => {
  const r = await openScoutRequest(req);
  if (r instanceof Response) return r;
  try {
    const profileId = await ownedProfileId(r, r.body.profile_id);
    if (!profileId) return scoutJson({ ok: false, error: "Profile not found" }, 404);

    const apiKey = Deno.env.get("APOLLO_API_KEY");
    if (!apiKey) {
      console.log("scout: no provider key, skipping");
      return scoutJson({ ok: false, reason: "no_provider_key" });
    }

    const limit = sampleRateLimit(await recentSampleRuns(r));
    if (!limit.allowed) return scoutJson({ ok: false, reason: "rate_limited" });

    // Log first so concurrent calls count against the limit.
    const { data: run } = await r.admin
      .from("scout_runs").insert({ workspace_id: r.workspaceId, profile_id: profileId, kind: "sample" })
      .select("id").single();
    const finish = (patch: Record<string, unknown>) =>
      run?.id ? r.admin.from("scout_runs").update({ finished_at: new Date().toISOString(), ...patch }).eq("id", run.id) : null;

    const profile = clampProfile(r.body.profile);
    const page = Math.min(5, Math.max(1, Math.floor(Number(r.body.page) || 1)));
    const search = await apolloSearchPeople(
      { fetch, apiKey },
      toApolloFilters(profile, r.settings.scout_allow_eu ? [] : EU_UK_EEA_COUNTRIES),
      page,
    );
    if (search.error) {
      await finish({ error: search.error });
      return scoutJson({ ok: false, reason: "provider_error" });
    }

    const { kept } = filterScoutCandidates(search.data, await filterContext(r));
    const pool = kept.slice(0, 25);
    const ai = pool.length
      ? await callScoutAi("scout_pick_samples", {
        profile,
        max: 5,
        candidates: pool.map((s) => ({
          id: s.provider_person_id, first_name: s.first_name, title: s.title,
          company: s.company_name, company_size: s.company_size,
        })),
      })
      : null;
    const picks = parseSamplePicks(ai, pool);
    await finish({ candidates_found: search.data.length, candidates_kept: picks.length });

    return scoutJson({
      ok: true,
      remaining: limit.remaining - 1,
      samples: picks.map(({ stub, reason }) => ({
        id: stub.provider_person_id,
        name: stub.name ?? stub.first_name,
        title: stub.title,
        company: stub.company_name,
        company_size: stub.company_size,
        location: stub.location,
        reason,
      })),
    });
  } catch (e) {
    console.error("[scout-sample] error:", e instanceof Error ? e.message : e);
    return scoutJson({ ok: false, error: "Internal error" }, 500);
  }
});
