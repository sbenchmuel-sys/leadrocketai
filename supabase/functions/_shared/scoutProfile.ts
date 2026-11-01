// ============================================================
// scoutProfile — the Lead Scout target profile (scout_profiles.profile_json).
//
// Pure and cross-runtime: imported by the scout-* edge functions AND by the
// setup panel in src/ (via @shared/scoutProfile). No Deno.*, no clients.
//
//   clampProfile      AI output → a safe profile_json (unknown keys dropped,
//                     lists trimmed/deduped/capped, seniorities + employee
//                     ranges forced into Apollo's formats, anchor ids limited
//                     to the leads the server actually offered).
//   profileSegments   the plain-English sentence as text + removable chips.
//   removeChip        chip ✕ → profile without that value.
//   needsInput / sampleRateLimit / parseSamplePicks / clampVotes / toApolloFilters
//                     the small decisions the edge functions make.
//
// The sentence is built here, not by the AI, so removing a chip rewrites it
// instantly and the stored profile_sentence always matches the chips.
// Tested in scoutProfile.test.ts (Deno) and src/test/scoutProfileChips.test.ts.
// ============================================================

export interface ScoutProfile {
  titles: string[];
  seniorities: string[];
  industries: string[];
  /** Apollo format "min,max" ("10001," = no upper bound). */
  employee_ranges: string[];
  locations: string[];
  keywords: string[];
  exclusions: string[];
  anchor_lead_ids: string[];
}

export type ProfileField = keyof ScoutProfile;

const LIMITS: Record<ProfileField, number> = {
  titles: 10,
  seniorities: 6,
  industries: 8,
  employee_ranges: 6,
  locations: 8,
  keywords: 8,
  exclusions: 10,
  anchor_lead_ids: 3,
};
const MAX_TEXT = 60;

/** Apollo person_seniorities values. */
export const SENIORITIES = [
  "owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager", "senior", "entry", "intern",
] as const;
const SENIORITY_LABELS: Record<string, string> = {
  owner: "owners", founder: "founders", c_suite: "C-suite", partner: "partners", vp: "VPs",
  head: "heads of department", director: "directors", manager: "managers", senior: "senior staff",
  entry: "entry-level staff", intern: "interns",
};
const SENIORITY_ALIASES: Record<string, string> = {
  "c-suite": "c_suite", "c suite": "c_suite", csuite: "c_suite", executive: "c_suite",
  "vice president": "vp", "vice_president": "vp", vps: "vp", directors: "director",
  managers: "manager", owners: "owner", founders: "founder",
};

/** 👎 reason chips (stored on votes, sent to scout-refine). */
export const DOWNVOTE_REASONS = [
  "wrong role", "wrong industry", "too small", "too big", "wrong region", "competitor",
] as const;

export const NEEDS_INPUT_QUESTIONS = ["Who do you sell to?", "Where?"];
export const MIN_GOOD_LEADS = 5;
export const SAMPLE_LIMIT_PER_HOUR = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emptyProfile(): ScoutProfile {
  return {
    titles: [], seniorities: [], industries: [], employee_ranges: [],
    locations: [], keywords: [], exclusions: [], anchor_lead_ids: [],
  };
}

/** "  VP   Sales\n" → "VP Sales"; non-strings → null. */
function cleanText(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  // deno-lint-ignore no-control-regex
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, MAX_TEXT).trim() : null;
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
}

function uniq(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeSeniority(v: unknown): string | null {
  const s = cleanText(v)?.toLowerCase();
  if (!s) return null;
  const mapped = SENIORITY_ALIASES[s] ?? s.replace(/[\s-]+/g, "_");
  return (SENIORITIES as readonly string[]).includes(mapped) ? mapped : null;
}

/** "50-500" | "50–500" | "50,500" | "10001+" | "10,001+" → "min,max" (or "min,"). */
export function normalizeEmployeeRange(v: unknown): string | null {
  const s = cleanText(v);
  if (!s) return null;
  const plus = s.match(/^(\d[\d,]*)\s*\+$/);
  if (plus) {
    const min = Number(plus[1].replace(/,/g, ""));
    return min >= 1 && min <= 1_000_000 ? `${min},` : null;
  }
  const m = s.match(/^(\d+)\s*(?:-|–|—|,|to)\s*(\d*)$/i);
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] === "" ? null : Number(m[2]);
  if (min < 1 || min > 1_000_000) return null;
  if (max !== null && (max < min || max > 1_000_000)) return null;
  return `${min},${max ?? ""}`;
}

/**
 * Anything (usually AI JSON) → a valid profile. Unknown keys are dropped.
 * `allowedAnchorIds` = the lead ids the caller offered; any other id is
 * dropped so the model can't invent or leak a lead.
 */
export function clampProfile(raw: unknown, allowedAnchorIds: Iterable<string> = []): ScoutProfile {
  // deno-lint-ignore no-explicit-any
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, any>;
  const text = (field: ProfileField) =>
    uniq(asList(r[field]).map(cleanText).filter((s): s is string => !!s), LIMITS[field]);
  const allowed = new Set([...allowedAnchorIds].map((id) => id.toLowerCase()));
  return {
    titles: text("titles"),
    seniorities: uniq(asList(r.seniorities).map(normalizeSeniority).filter((s): s is string => !!s), LIMITS.seniorities),
    industries: text("industries"),
    employee_ranges: uniq(
      asList(r.employee_ranges).map(normalizeEmployeeRange).filter((s): s is string => !!s),
      LIMITS.employee_ranges,
    ),
    locations: text("locations"),
    keywords: text("keywords"),
    exclusions: text("exclusions"),
    anchor_lead_ids: uniq(
      asList(r.anchor_lead_ids)
        .filter((id): id is string => typeof id === "string" && UUID_RE.test(id) && allowed.has(id.toLowerCase())),
      LIMITS.anchor_lead_ids,
    ),
  };
}

export function isEmptyProfile(p: ScoutProfile): boolean {
  return Object.values(p).every((list) => list.length === 0);
}

// ── Sentence + chips ────────────────────────────────────────────────────────

export interface Chip {
  field: ProfileField;
  value: string;
  label: string;
}
export type Segment = string | Chip;

export function employeeRangeLabel(range: string): string {
  const [min, max] = range.split(",");
  const n = (s: string) => Number(s).toLocaleString("en-US");
  return max ? `${n(min)}–${n(max)} employees` : `${n(min)}+ employees`;
}

function chipLabel(field: ProfileField, value: string, anchorNames: Record<string, string>): string {
  if (field === "seniorities") return SENIORITY_LABELS[value] ?? value;
  if (field === "employee_ranges") return employeeRangeLabel(value);
  if (field === "anchor_lead_ids") return anchorNames[value] || "one of your leads";
  return value;
}

/** Chips joined "a", "a or b", "a, b or c". */
function joined(chips: Chip[], last: string): Segment[] {
  const out: Segment[] = [];
  chips.forEach((c, i) => {
    if (i > 0) out.push(i === chips.length - 1 ? ` ${last} ` : ", ");
    out.push(c);
  });
  return out;
}

/**
 * The profile as one plain sentence, e.g.
 * "I'll look for VP Sales or directors at fintech companies, 51–200 employees,
 *  in United States, similar to Acme Pay. Skipping banks."
 */
export function profileSegments(p: ScoutProfile, anchorNames: Record<string, string> = {}): Segment[] {
  const chips = (field: ProfileField) => p[field].map((value) => ({ field, value, label: chipLabel(field, value, anchorNames) }));
  const who = [...chips("titles"), ...chips("seniorities")];
  const out: Segment[] = ["I'll look for "];
  out.push(...(who.length ? joined(who, "or") : ["people"]));
  if (p.industries.length) out.push(" at ", ...joined(chips("industries"), "or"), " companies");
  if (p.employee_ranges.length) out.push(", ", ...joined(chips("employee_ranges"), "or"));
  if (p.locations.length) out.push(", in ", ...joined(chips("locations"), "or"));
  if (p.keywords.length) out.push(", interested in ", ...joined(chips("keywords"), "or"));
  if (p.anchor_lead_ids.length) out.push(", similar to ", ...joined(chips("anchor_lead_ids"), "and"));
  out.push(".");
  if (p.exclusions.length) out.push(" Skipping ", ...joined(chips("exclusions"), "and"), ".");
  return out;
}

export function profileSentence(p: ScoutProfile, anchorNames: Record<string, string> = {}): string {
  return profileSegments(p, anchorNames).map((s) => (typeof s === "string" ? s : s.label)).join("");
}

export function removeChip(p: ScoutProfile, chip: Pick<Chip, "field" | "value">): ScoutProfile {
  return { ...p, [chip.field]: p[chip.field].filter((v) => v !== chip.value) };
}

// ── Edge-function decisions ─────────────────────────────────────────────────

/** Ask the rep two questions when there's too little history and no answers yet. */
export function needsInput(goodLeadCount: number, hasAnswers: boolean): boolean {
  return goodLeadCount < MIN_GOOD_LEADS && !hasAnswers;
}

/** scout-sample: `recentSampleRuns` = this rep's kind='sample' runs in the last hour. */
export function sampleRateLimit(recentSampleRuns: number, limit = SAMPLE_LIMIT_PER_HOUR): { allowed: boolean; remaining: number } {
  const remaining = Math.max(0, limit - recentSampleRuns);
  return { allowed: remaining > 0, remaining };
}

export interface Vote {
  vote: "up" | "down";
  reason: string | null;
  title: string | null;
  company: string | null;
  company_size: string | null;
  location: string | null;
}

/** Client-supplied votes → bounded, known-shape list (max 20). */
export function clampVotes(raw: unknown): Vote[] {
  return asList(raw).slice(0, 20).flatMap((v) => {
    // deno-lint-ignore no-explicit-any
    const o = (v && typeof v === "object" ? v : {}) as Record<string, any>;
    if (o.vote !== "up" && o.vote !== "down") return [];
    const reason = cleanText(o.reason)?.toLowerCase() ?? null;
    return [{
      vote: o.vote,
      reason: o.vote === "down" && reason && (DOWNVOTE_REASONS as readonly string[]).includes(reason) ? reason : null,
      title: cleanText(o.title),
      company: cleanText(o.company),
      company_size: cleanText(o.company_size),
      location: cleanText(o.location),
    }];
  });
}

export interface SamplePick<T> {
  stub: T;
  reason: string;
}

const FALLBACK_REASON = "Matches the people and companies you're looking for.";

/**
 * AI `{ picks: [{ id, reason }] }` → up to `max` stubs that really came back from
 * the search (unknown ids dropped, duplicates dropped). If the AI returned
 * no `picks` array at all (failed/malformed), falls back to the first `max`
 * stubs with a generic reason; a valid empty array stays empty.
 */
export function parseSamplePicks<T extends { provider_person_id: string }>(
  raw: unknown,
  stubs: T[],
  max = 5,
): SamplePick<T>[] {
  const byId = new Map(stubs.map((s) => [s.provider_person_id, s]));
  // deno-lint-ignore no-explicit-any
  const picks = asList((raw as any)?.picks);
  const out: SamplePick<T>[] = [];
  const used = new Set<string>();
  for (const p of picks) {
    // deno-lint-ignore no-explicit-any
    const id = typeof (p as any)?.id === "string" ? (p as any).id : null;
    const stub = id ? byId.get(id) : undefined;
    if (!stub || used.has(id!)) continue;
    used.add(id!);
    // deno-lint-ignore no-explicit-any
    const reason = typeof (p as any).reason === "string" ? (p as any).reason.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    out.push({ stub, reason: reason || FALLBACK_REASON });
    if (out.length >= max) break;
  }
  // A well-formed `picks` array is the AI's answer, even when empty (everyone hit
  // an exclusion) — keywords/exclusions are enforced only here. Fall back to the
  // first stubs only when the AI output was missing or malformed.
  // deno-lint-ignore no-explicit-any
  if (out.length === 0 && !Array.isArray((raw as any)?.picks)) {
    return stubs.slice(0, max).map((stub) => ({ stub, reason: FALLBACK_REASON }));
  }
  return out;
}

/**
 * Profile → Apollo People Search filters (shape of ApolloSearchFilters in
 * prospectProviders.ts). `notLocations` = EU_UK_EEA_COUNTRIES unless the
 * workspace allows EU.
 * ponytail: keywords + exclusions are NOT sent to Apollo (q_keywords is an AND
 * full-text match and would usually return nobody); the AI pick step applies
 * them instead. Industries go to organization_industries[], which only matches
 * Apollo's own industry names. Upgrade: map to organization_industry_tag_ids.
 */
export function toApolloFilters(p: ScoutProfile, notLocations: string[], perPage = 25) {
  return {
    titles: p.titles,
    seniorities: p.seniorities,
    industries: p.industries,
    employeeRanges: p.employee_ranges,
    locations: p.locations,
    notLocations,
    perPage,
  };
}
