// ============================================================
// scoutEnrich — what happens when a rep approves a Lead Scout suggestion.
//
// Pure (I/O injected) so the order and the credit rules are unit-tested
// (scoutEnrich.test.ts). The scout-enrich edge function wires the DB + providers.
//
// Per candidate, in this order — every step can end it, and nothing after a
// "no" spends another credit:
//   1. Apollo enrichment (1 credit). No verified email → dismissed
//      'no_verified_email' (Shai 2026-11-01: leads.email is NOT NULL; no
//      LinkedIn/phone-only leads). Lusha is never called.
//   2. Email validation (_shared/emailValidation, same rules as import): an
//      invalid/junk address → dismissed 'invalid_email', no Lusha. (Done before
//      Lusha, not after — it's free and saves a phone credit on a dead lead.)
//   3. FULL scoutFilters with the now-known email / LinkedIn / real name /
//      location (existing + unsubscribed leads, suppression, dismissed and
//      internal domains, EU/UK) → dismissed with that reason, no Lusha.
//   4. Lusha phone, only when a Lusha key exists (no key → no phone).
//   5. The lead payload (source_type 'ai_scout', outbound prospecting, stage
//      'new', raw_import_json.scout). No cadence enrollment, ever.
//
// Credits: candidates are claimed (pending → approved, atomically, by the
// caller's `claim`) BEFORE any provider call, so a double click or two
// concurrent Approve-alls can't enrich the same person twice. After the claim,
// a failure with nothing final reverts the row to pending (no silent loss).
// ============================================================
import { classifyEmail } from "./emailValidation.ts";
import type { EnrichedEmail, PhoneResult, ProviderResult } from "./prospectProviders.ts";
import { filterScoutCandidates, type ScoutFilterContext } from "./scoutFilters.ts";

export const MAX_ENRICH_PER_CALL = 100;
export const ENRICH_CONCURRENCY = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lead_candidates columns a scout row carries (source = 'ai_scout'). */
export interface ScoutCandidateRow {
  id: string;
  workspace_id: string;
  owner_user_id: string | null;
  contact_name: string | null;
  company_domain: string | null;
  company_name: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  location: string | null;
  ai_reason: string | null;
  fit_label: string | null;
  scout_batch_id: string | null;
  anchor_lead_id: string | null;
  provider: string | null;
  provider_person_id: string | null;
}

export interface BatchInfo {
  profile_id: string | null;
  profile_sentence: string | null;
}

export interface FilterQuery {
  email: string;
  linkedin_url: string | null;
  domains: string[];
}

export interface EnrichDeps {
  apollo: (c: { provider_person_id: string }) => Promise<ProviderResult<EnrichedEmail | null>>;
  /** null when LUSHA_API_KEY is missing → leads are created without a phone. */
  lusha:
    | null
    | ((s: {
      provider_person_id: string;
      linkedin_url: string | null;
      first_name: string | null;
      last_name: string | null;
      company_domain: string | null;
      company_name: string | null;
    }) => Promise<ProviderResult<PhoneResult | null>>);
  /** Loads opt-out / dedupe lists relevant to this person (targeted queries). */
  loadFilterContext: (q: FilterQuery) => Promise<ScoutFilterContext>;
  now: () => Date;
}

export type EnrichOutcome =
  | { kind: "lead"; lead: Record<string, unknown>; email: string; apollo: number; lusha: number }
  | { kind: "dismissed"; reason: string; email: string | null; apollo: number; lusha: number }
  | { kind: "retry"; error: string; apollo: number; lusha: number };

/** Client input → unique UUIDs, capped (bounds credit spend per call). */
export function normalizeEnrichIds(raw: unknown, max = MAX_ENRICH_PER_CALL): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return [...new Set(list.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))].slice(0, max);
}

const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/** Dismiss reasons that the UI reports as "no verified email". */
export const NO_EMAIL_REASONS = new Set(["no_verified_email", "invalid_email"]);

export async function enrichCandidate(
  c: ScoutCandidateRow,
  batch: BatchInfo,
  deps: EnrichDeps,
  /** Leads created earlier in this same call (dedupe inside a batch). */
  createdThisCall: ScoutFilterContext["leads"],
): Promise<EnrichOutcome> {
  if (!c.provider_person_id || !c.owner_user_id) {
    return { kind: "retry", error: "candidate missing provider id or owner", apollo: 0, lusha: 0 };
  }

  // 1. Apollo: verified email or nothing.
  const enriched = await deps.apollo({ provider_person_id: c.provider_person_id });
  const apollo = enriched.credits;
  if (enriched.error) {
    // Nothing learned. If no credit was spent, let the rep try again.
    return apollo === 0
      ? { kind: "retry", error: enriched.error, apollo, lusha: 0 }
      : { kind: "dismissed", reason: "no_verified_email", email: null, apollo, lusha: 0 };
  }
  const p = enriched.data;
  const email = clean(p?.email)?.toLowerCase() ?? null;
  if (!p || !email) return { kind: "dismissed", reason: "no_verified_email", email: null, apollo, lusha: 0 };

  // 2. Same validation the import + enrollment use.
  if (classifyEmail(email) !== "valid") return { kind: "dismissed", reason: "invalid_email", email, apollo, lusha: 0 };

  // 3. Full filters, now that email / LinkedIn / real name / country are known.
  const name = [clean(p.first_name), clean(p.last_name)].filter(Boolean).join(" ") || clean(c.contact_name);
  const linkedin = p.linkedin_url ?? c.linkedin_url;
  const emailDomain = email.split("@")[1];
  let ctx: ScoutFilterContext;
  try {
    ctx = await deps.loadFilterContext({
      email,
      linkedin_url: linkedin,
      domains: [...new Set([c.company_domain, emailDomain].filter((d): d is string => !!d))],
    });
  } catch (e) {
    // Lists unreadable → retry, but the Apollo credit is already spent: report it.
    return { kind: "retry", error: e instanceof Error ? e.message : "filter lookup failed", apollo, lusha: 0 };
  }
  const stub = {
    provider: c.provider ?? "apollo",
    provider_person_id: c.provider_person_id,
    name,
    email,
    linkedin_url: linkedin,
    company_domain: c.company_domain,
    location: p.location ?? c.location,
  };
  // The candidate row itself is an existing scout candidate — don't let it block itself.
  const { dropped } = filterScoutCandidates([stub], {
    ...ctx,
    leads: [...ctx.leads, ...createdThisCall],
    existingScoutCandidates: [],
  });
  if (dropped.length) return { kind: "dismissed", reason: dropped[0].reason, email, apollo, lusha: 0 };
  // Claim the identity synchronously (before the Lusha await) so a sibling
  // candidate in this call resolving to the same person is caught above.
  createdThisCall.push({ email, linkedin_url: linkedin, name });

  // 4. Phone — only now, and only with a key.
  let phone: string | null = null;
  let lusha = 0;
  if (deps.lusha) {
    const ph = await deps.lusha({
      provider_person_id: c.provider_person_id,
      linkedin_url: linkedin,
      first_name: clean(p.first_name),
      last_name: clean(p.last_name),
      company_domain: c.company_domain,
      company_name: c.company_name,
    });
    lusha = ph.credits;
    phone = ph.data?.phone ?? null; // a Lusha miss/error never blocks the lead
  }

  // 5. The lead. Mirrors PendingLeadsTab.createLeadFromCandidate's shape.
  const lead: Record<string, unknown> = {
    workspace_id: c.workspace_id,
    owner_user_id: c.owner_user_id,
    name: name || email.split("@")[0],
    company: clean(c.company_name) || clean(c.company_domain) || emailDomain || "Unknown",
    email,
    phone,
    job_title: clean(c.job_title),
    linkedin_url: linkedin,
    city: p.city,
    state: p.state,
    country: p.country,
    strategy: "fast",
    motion: "outbound_prospecting",
    source_type: "ai_scout",
    stage: "new",
    last_activity_at: deps.now().toISOString(),
    raw_import_json: {
      scout: {
        reason: c.ai_reason,
        fit_label: c.fit_label,
        profile_sentence: batch.profile_sentence,
        profile_id: batch.profile_id,
        batch_id: c.scout_batch_id,
        anchor_lead_id: c.anchor_lead_id,
        provider: c.provider ?? "apollo",
        provider_person_id: c.provider_person_id,
        enriched_at: deps.now().toISOString(),
        phone_provider: phone ? "lusha" : null,
      },
    },
  };
  return { kind: "lead", lead, email, apollo, lusha };
}

export type CreateLeadResult = { id: string } | { duplicate: true } | { error: string };

export interface EnrichIO {
  /** Atomic pending → approved for these ids (caller's workspace, ai_scout only). Returns the rows it won. */
  claim: (ids: string[]) => Promise<ScoutCandidateRow[]>;
  batchInfo: (batchIds: string[]) => Promise<Map<string, BatchInfo>>;
  createLead: (payload: Record<string, unknown>) => Promise<CreateLeadResult>;
  /** Patch one claimed candidate row. */
  update: (id: string, patch: Record<string, unknown>) => Promise<void>;
}

export interface EnrichSummary {
  claimed: number;
  added: number;
  skipped_no_email: number;
  skipped_other: number;
  /** Reverted to pending (provider down, insert failed…). */
  retry: number;
  apollo_credits: number;
  lusha_credits: number;
  lead_ids: string[];
  batch_ids: string[];
  errors: string[];
}

const REVERT = { status: "pending", resolved_at: null, resolved_lead_id: null };

export async function runEnrich(
  ids: string[],
  io: EnrichIO,
  deps: EnrichDeps,
  concurrency = ENRICH_CONCURRENCY,
): Promise<EnrichSummary> {
  const sum: EnrichSummary = {
    claimed: 0, added: 0, skipped_no_email: 0, skipped_other: 0, retry: 0,
    apollo_credits: 0, lusha_credits: 0, lead_ids: [], batch_ids: [], errors: [],
  };
  const claimed = ids.length ? await io.claim(ids) : [];
  sum.claimed = claimed.length;
  if (!claimed.length) return sum;
  const batchIds = [...new Set(claimed.map((c) => c.scout_batch_id).filter((b): b is string => !!b))];
  sum.batch_ids = batchIds;
  const batches = await io.batchInfo(batchIds);
  const created: ScoutFilterContext["leads"] = [];
  const resolvedAt = () => deps.now().toISOString();

  const one = async (c: ScoutCandidateRow) => {
    let outcome: EnrichOutcome;
    try {
      outcome = await enrichCandidate(c, batches.get(c.scout_batch_id ?? "") ?? { profile_id: null, profile_sentence: null }, deps, created);
    } catch (e) {
      outcome = { kind: "retry", error: e instanceof Error ? e.message : "enrich failed", apollo: 0, lusha: 0 };
    }
    sum.apollo_credits += outcome.apollo;
    sum.lusha_credits += outcome.lusha;
    try {
      if (outcome.kind === "lead") {
        const res = await io.createLead(outcome.lead);
        if ("id" in res) {
          await io.update(c.id, { resolved_lead_id: res.id, contact_email: outcome.email, resolved_at: resolvedAt() });
          sum.added++;
          sum.lead_ids.push(res.id);
          return;
        }
        if ("duplicate" in res) {
          // A lead with this email appeared since the filter ran: final, not a retry.
          outcome = { kind: "dismissed", reason: "existing_lead", email: outcome.email, apollo: 0, lusha: 0 };
        } else {
          // ponytail: credits for this person are spent; reverting means a retry
          // re-enriches (and may re-charge). Accepted: losing the approval silently is worse.
          outcome = { kind: "retry", error: res.error, apollo: 0, lusha: 0 };
        }
      }
      if (outcome.kind === "dismissed") {
        await io.update(c.id, {
          status: "dismissed",
          dismiss_reason: outcome.reason,
          resolved_at: resolvedAt(),
          ...(outcome.email ? { contact_email: outcome.email } : {}),
        });
        if (NO_EMAIL_REASONS.has(outcome.reason)) sum.skipped_no_email++;
        else sum.skipped_other++;
        return;
      }
      sum.errors.push(outcome.error);
      sum.retry++;
      await io.update(c.id, REVERT);
    } catch (e) {
      sum.errors.push(e instanceof Error ? e.message : "update failed");
      sum.retry++;
      await io.update(c.id, REVERT).catch(() => {});
    }
  };

  const queue = [...claimed];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) await one(c);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return sum;
}

/**
 * A batch with no pending candidates left counts once toward its profile's
 * approved_batches (the UI offers auto-approve after 2). The conditional
 * resolved_at UPDATE makes the count exactly-once under concurrency. Called by
 * scout-enrich after approvals AND by scout-weekly-run's sweep (a batch whose
 * last card was dismissed by hand never passes through scout-enrich).
 * ponytail: read-then-write increment on approved_batches; the resolved_at gate
 * already serialises per batch, two batches of one profile racing could lose one.
 */
// deno-lint-ignore no-explicit-any
export async function countResolvedBatches(admin: any, workspaceId: string, batchIds: string[]) {
  for (const batchId of batchIds) {
    try {
      const { count } = await admin.from("lead_candidates").select("id", { count: "exact", head: true })
        .eq("scout_batch_id", batchId).eq("workspace_id", workspaceId).eq("status", "pending");
      if (count !== 0) continue;
      const { data: won } = await admin.from("scout_runs").update({ resolved_at: new Date().toISOString() })
        .eq("id", batchId).eq("workspace_id", workspaceId).is("resolved_at", null).select("profile_id");
      const profileId = won?.[0]?.profile_id;
      if (!profileId) continue;
      const { data: prof } = await admin.from("scout_profiles").select("approved_batches").eq("id", profileId).maybeSingle();
      if (prof) {
        await admin.from("scout_profiles").update({ approved_batches: (prof.approved_batches ?? 0) + 1 }).eq("id", profileId);
      }
    } catch (e) {
      console.warn("[scout] batch count failed", e instanceof Error ? e.message : e);
    }
  }
}
