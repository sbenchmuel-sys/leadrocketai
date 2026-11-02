// ============================================================
// scoutGate — shared request plumbing for the scout-* edge functions.
//
// Every Scout request: user JWT → workspace membership → master switch
// (workspace_automation_settings.scout_enabled, read with the service role).
// Missing row, missing column (prod before the Unit 1 migration) or any read
// error = "not enabled": a clean { ok:false, reason:"not_enabled" }, never a 500.
// Deno-only (creates clients); NOT imported from src/.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertWorkspaceMembership, resolveUser } from "./authz.ts";
import { normalizeEmail } from "./leadCandidateDetection.ts";
import { normalizeDomain } from "./prospectProviders.ts";
import type { ScoutFilterContext } from "./scoutFilters.ts";
import { creditCeilingReached, monthStartIso, parseCreditCeiling } from "./scoutWeekly.ts";

// deno-lint-ignore no-explicit-any
export type AdminClient = any; // ponytail: no generated Database type in _shared; scout tables aren't in types.ts yet.

export const scoutCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export function scoutJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...scoutCors, "Content-Type": "application/json" } });
}

export interface ScoutRequest {
  admin: AdminClient;
  userId: string;
  workspaceId: string;
  body: Record<string, unknown>;
  settings: { scout_weekly_cap: number; scout_allow_eu: boolean };
}

export async function openScoutRequest(req: Request): Promise<ScoutRequest | Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: scoutCors });
  const user = await resolveUser(req);
  if (!user) return scoutJson({ ok: false, error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.workspace_id !== "string") {
    return scoutJson({ ok: false, error: "workspace_id is required" }, 400);
  }
  const admin: AdminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const member = await assertWorkspaceMembership(admin, body.workspace_id, user.userId);
  if (!member.ok) return scoutJson({ ok: false, error: member.error }, member.status ?? 403);

  const settings = await readScoutSettings(admin, body.workspace_id);
  if (!settings) return scoutJson({ ok: false, reason: "not_enabled" });

  return { admin, userId: user.userId, workspaceId: body.workspace_id, body, settings };
}

/** Scout settings when the master switch is ON; null when off, missing, or unreadable. */
export async function readScoutSettings(
  admin: AdminClient,
  workspaceId: string,
): Promise<ScoutRequest["settings"] | null> {
  const { data, error } = await admin
    .from("workspace_automation_settings")
    .select("scout_enabled, scout_weekly_cap, scout_allow_eu")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error || data?.scout_enabled !== true) return null;
  return { scout_weekly_cap: data.scout_weekly_cap ?? 0, scout_allow_eu: data.scout_allow_eu === true };
}

/** "eu.acme.com" → ["eu.acme.com", "acme.com"] (filters match parent domains too). */
function withParents(domains: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const d of domains) {
    const parts = normalizeDomain(d)?.split(".") ?? [];
    for (let i = 0; i < parts.length - 1; i++) out.add(parts.slice(i).join("."));
  }
  return [...out];
}

/** PostgREST or() of case-insensitive equality on domains (opt-out lists aren't guaranteed lowercase). */
const domainsIlike = (col: string, domains: string[]) =>
  domains.map((d) => `${col}.ilike.${d.replace(/[^a-z0-9.-]/gi, "")}`).join(",");

const values = (rows: unknown, key: string): string[] =>
  ((rows as Array<Record<string, unknown>> | null) ?? []).map((r) => r[key]).filter((v): v is string => typeof v === "string");

/**
 * Lists that can bite BEFORE enrichment (search stubs have no email, LinkedIn
 * or real surname): suppressed / dismissed / internal domains and existing
 * scout rows for these provider people. Targeted queries, so no 1000-row cap.
 */
export async function loadPreFilterContext(
  admin: AdminClient,
  workspaceId: string,
  allowEu: boolean,
  stubs: Array<{ provider: string; provider_person_id: string; company_domain: string | null }>,
): Promise<ScoutFilterContext> {
  const domains = withParents(stubs.map((s) => s.company_domain));
  const ids = [...new Set(stubs.map((s) => s.provider_person_id))];
  const none = Promise.resolve({ data: [] });
  const [sup, dis, internal, existing] = await Promise.all([
    domains.length
      ? admin.from("campaign_suppression_list").select("value").eq("workspace_id", workspaceId).eq("kind", "domain")
        .or(domainsIlike("value", domains))
      : none,
    domains.length
      ? admin.from("workspace_dismissed_domains").select("domain").eq("workspace_id", workspaceId).or(domainsIlike("domain", domains))
      : none,
    admin.from("workspace_internal_domains").select("domain").eq("workspace_id", workspaceId),
    ids.length
      ? admin.from("lead_candidates").select("provider, provider_person_id").eq("workspace_id", workspaceId)
        .eq("source", "ai_scout").in("provider_person_id", ids)
      : none,
  ]);
  for (const r of [sup, dis, internal, existing]) {
    if ((r as { error?: unknown }).error) throw new Error("scout filter: pre-filter lookup failed");
  }
  return {
    leads: [],
    unsubscribedEmails: [],
    suppressedEmails: [],
    suppressedDomains: values(sup.data, "value"),
    dismissedEmails: [],
    dismissedDomains: values(dis.data, "domain"),
    internalDomains: values(internal.data, "domain"),
    existingScoutCandidates: existing.data ?? [],
    allowEu,
  };
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * PostgREST or() matching every address with the same normalizeEmail identity
 * as `email` (case-insensitive bare address + any "+tag" alias of it), so the
 * fetch sees every row filterScoutCandidates would treat as the same person.
 */
export function emailIdentityOr(col: string, email: string): string {
  const [local, domain = ""] = normalizeEmail(email).split("@").map((s) => likeEscape(s).replace(/[,()*]/g, ""));
  return `${col}.ilike.${local}@${domain},${col}.ilike.${local}+*@${domain}`;
}

/**
 * The FULL filter context for one enriched person: leads matching the email,
 * the LinkedIn profile or the company/email domain (for the name+domain rule),
 * unsubscribed among them, suppression + dismiss lists for that email/domain.
 */
export async function loadEnrichFilterContext(
  admin: AdminClient,
  workspaceId: string,
  allowEu: boolean,
  q: { email: string; linkedin_url: string | null; domains: string[] },
): Promise<ScoutFilterContext> {
  const domains = withParents(q.domains);
  const slug = q.linkedin_url?.split("/in/")[1];
  const none = Promise.resolve({ data: [] });
  const leadSel = "email, linkedin_url, name, unsubscribed";
  const [byEmail, byLinkedin, byDomain, sup, disEmail, disDomain, internal] = await Promise.all([
    admin.from("leads").select(leadSel).eq("workspace_id", workspaceId).or(emailIdentityOr("email", q.email)),
    slug
      ? admin.from("leads").select(leadSel).eq("workspace_id", workspaceId).ilike("linkedin_url", `%/in/${likeEscape(slug)}%`)
      : none,
    // ponytail: name+domain rule only sees the first 1000 leads at a domain; exact email + LinkedIn are separate queries.
    admin.from("leads").select(leadSel).eq("workspace_id", workspaceId)
      .or(q.domains.map((d) => `email.ilike.*@${d.replace(/[,()*]/g, "")}`).join(",") || "email.is.null")
      .limit(1000),
    admin.from("campaign_suppression_list").select("kind, value").eq("workspace_id", workspaceId)
      .or([emailIdentityOr("value", q.email), domainsIlike("value", domains)].filter(Boolean).join(",")),
    admin.from("workspace_dismissed_emails").select("email").eq("workspace_id", workspaceId).or(emailIdentityOr("email", q.email)),
    domains.length
      ? admin.from("workspace_dismissed_domains").select("domain").eq("workspace_id", workspaceId).or(domainsIlike("domain", domains))
      : none,
    admin.from("workspace_internal_domains").select("domain").eq("workspace_id", workspaceId),
  ]);
  // Fail closed: an unreadable opt-out list must never let a person through.
  for (const r of [sup, disEmail, disDomain, internal]) {
    if ((r as { error?: unknown }).error) throw new Error("scout filter: opt-out lookup failed");
  }
  for (const r of [byEmail, byLinkedin, byDomain]) {
    if ((r as { error?: unknown }).error) throw new Error("scout filter: leads lookup failed");
  }
  const leads = [...(byEmail.data ?? []), ...(byLinkedin.data ?? []), ...(byDomain.data ?? [])] as Array<
    { email: string | null; linkedin_url: string | null; name: string | null; unsubscribed: boolean | null }
  >;
  const supRows = (sup.data ?? []) as Array<{ kind: string; value: string }>;
  return {
    leads,
    unsubscribedEmails: leads.filter((l) => l.unsubscribed && l.email).map((l) => l.email!),
    suppressedEmails: supRows.filter((r) => r.kind === "email").map((r) => r.value),
    suppressedDomains: supRows.filter((r) => r.kind === "domain").map((r) => r.value),
    dismissedEmails: values(disEmail.data, "email"),
    dismissedDomains: values(disDomain.data, "domain"),
    internalDomains: values(internal.data, "domain"),
    existingScoutCandidates: [],
    allowEu,
  };
}

/** The caller's own scout profile row (any status), or null. */
export async function ownedProfileId(r: ScoutRequest, profileId: unknown): Promise<string | null> {
  if (typeof profileId !== "string") return null;
  const { data } = await r.admin
    .from("scout_profiles")
    .select("id")
    .eq("id", profileId)
    .eq("workspace_id", r.workspaceId)
    .eq("owner_user_id", r.userId)
    .maybeSingle();
  return data?.id ?? null;
}

/** id → company (or name) for the caller's own leads among `ids`. Unknown ids are absent. */
export async function anchorNames(r: ScoutRequest, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data } = await r.admin
    .from("leads")
    .select("id, name, company")
    .in("id", ids.slice(0, 10))
    .eq("workspace_id", r.workspaceId)
    .eq("owner_user_id", r.userId);
  return Object.fromEntries((data ?? []).map((l: { id: string; name: string; company: string }) => [l.id, l.company || l.name]));
}

/** One scout_* task through ai_task (service role). Returns the parsed result or null. */
export async function callScoutAi(task: string, payload: unknown): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ai_task`, {
      method: "POST",
      signal: AbortSignal.timeout(55_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ task, payload }),
    });
    const json = await res.json().catch(() => null);
    return res.ok && json?.ok && json.result && typeof json.result === "object" ? json.result : null;
  } catch (e) {
    console.error(`[scout] ${task} call failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Apollo + Lusha credits logged in scout_runs this UTC month, all workspaces. null = unreadable. */
async function monthCreditsUsed(admin: AdminClient, now: Date): Promise<number | null> {
  // ponytail: sums client-side, 1000 rows a page, only rows that spent credits
  // (enrich runs). Stops at 20 pages and reports "unknown" (= pause) beyond that;
  // upgrade to a SQL sum RPC if a month ever has >20k paid runs.
  let total = 0;
  for (let page = 0; page < 20; page++) {
    const { data, error } = await admin.from("scout_runs").select("apollo_credits, lusha_credits")
      .gte("started_at", monthStartIso(now)).or("apollo_credits.gt.0,lusha_credits.gt.0")
      .order("id").range(page * 1000, page * 1000 + 999);
    if (error) return null;
    const rows = (data ?? []) as Array<{ apollo_credits: number | null; lusha_credits: number | null }>;
    for (const r of rows) total += (r.apollo_credits ?? 0) + (r.lusha_credits ?? 0);
    if (rows.length < 1000) return total;
  }
  return null;
}

/**
 * SCOUT_MONTHLY_CREDIT_CEILING gate for anything that calls Apollo/Lusha.
 * Reached → true and one volume_alert row in cron_run_log (same shape as the
 * automation-executor tripwire). Unset = no limit (never reads the DB).
 */
export async function scoutCreditCeilingHit(admin: AdminClient, source: string): Promise<boolean> {
  const ceiling = parseCreditCeiling(Deno.env.get("SCOUT_MONTHLY_CREDIT_CEILING"));
  if (ceiling === null) return false;
  const used = await monthCreditsUsed(admin, new Date());
  if (!creditCeilingReached(ceiling, used)) return false;
  console.warn(`scout: monthly credit ceiling reached (${used ?? "unknown"}/${ceiling}), pausing ${source}`);
  // At most one alert per source per 24h, so the hourly cron doesn't log 24 a day while paused.
  const { data: recent } = await admin.from("cron_run_log").select("id").eq("job_name", "volume_alert")
    .eq("metadata->>scope", "scout_credit_ceiling").eq("metadata->>source", source)
    .gte("completed_at", new Date(Date.now() - 86_400_000).toISOString()).limit(1);
  if (recent?.length) return true;
  const { error } = await admin.from("cron_run_log").insert({
    job_name: "volume_alert",
    request_id: crypto.randomUUID(),
    status: "ok",
    status_code: 200,
    completed_at: new Date().toISOString(),
    duration_ms: 0,
    metadata: { scope: "scout_credit_ceiling", source, credits_this_month: used, ceiling },
  });
  if (error) console.warn("[scout] volume_alert log failed:", error.message);
  return true;
}
