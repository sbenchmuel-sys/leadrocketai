// ============================================================
// scoutPrompts — Lead Scout's AI tasks, dispatched from ai_task.
//
// ai_task only routes `scout_*` tasks here (service-role callers only); the
// prompts, model choice and JSON parsing live in this file so the 2.7k-line
// gateway stays untouched. Output is NOT trusted: the scout-* edge functions
// run it through clampProfile / parseSamplePicks (scoutProfile.ts).
// Pure: the API key and (for tests) fetch are passed in.
// ============================================================
import { aiGatewayFetch } from "./aiGateway.ts";

const PROFILE_SCHEMA = `{
  "titles": string[],            // job titles, e.g. "VP Sales", "Head of Revenue"
  "seniorities": string[],       // only: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry
  "industries": string[],        // LinkedIn-style industry names, lowercase, e.g. "financial services"
  "employee_ranges": string[],   // company size as "min,max", e.g. "51,200", "201,500", "10001,"
  "locations": string[],         // countries or US states, e.g. "United States", "Texas"
  "keywords": string[],          // what the company does, e.g. "payments", "ISO"
  "exclusions": string[],        // kinds of companies/people to skip, e.g. "banks"
  "anchor_lead_ids": string[]    // up to 3 ids, ONLY from the lead list given to you
}`;

const SYSTEM = "You help a B2B sales rep describe who to prospect. Output only valid JSON. Never invent facts about real people or companies. Keep every list short and specific.";

export const SCOUT_PROMPTS = {
  scout_build_profile: `From the rep's best leads (won, meeting booked, or replied) and their company knowledge, describe the ideal people to prospect next.
If "answers" is present, the rep answered "Who do you sell to?" and "Where?" — treat those answers as the strongest signal.
Pick up to 3 anchor leads that best represent the target (use their ids exactly as given).
Return JSON exactly in this shape:
${PROFILE_SCHEMA}`,

  scout_pick_samples: `Pick the best people for this target profile from the candidates. Prefer people who match the titles, industries and company size, and skip anyone matching an exclusion.
For each pick write one short, plain-English reason a sales rep would understand (max 15 words, no scores, no numbers about fit).
Use only candidate ids exactly as given. Return JSON: { "picks": [ { "id": string, "reason": string } ] } with at most "max" picks, best first.`,

  scout_refine_profile: `Update the target profile using the rep's feedback.
"votes": thumbs up/down on sample people, sometimes with a reason (wrong role, wrong industry, too small, too big, wrong region, competitor). Lean toward what got 👍, away from what got 👎.
"instruction": the rep's own words (e.g. "skip banks, add ISOs") — follow it.
Keep anchor_lead_ids unchanged unless the instruction says to drop one. Change only what the feedback supports.
Return JSON: { "profile": ${PROFILE_SCHEMA}, "note": string }  // note = one short plain sentence about what changed, e.g. "Got it, fewer banks."`,

  scout_rank_batch: `Rank the candidates for this week's prospect list against the target profile. Skip anyone matching an exclusion or clearly outside the titles, industries or company size.
For each pick write one short, plain-English reason a sales rep would understand (max 15 words, no scores, no numbers about fit).
"fit_label": "high" only for a clear match on role AND company; otherwise "good".
"anchor_lead_id": the id of the anchor lead this person most resembles, ONLY from the "anchors" list given to you, or null.
Use only candidate ids exactly as given. Return JSON: { "picks": [ { "id": string, "reason": string, "fit_label": "high" | "good", "anchor_lead_id": string | null } ] } with at most "max" picks, best first.`,
} as const;

export type ScoutTask = keyof typeof SCOUT_PROMPTS;

export function isScoutTask(task: unknown): task is ScoutTask {
  return typeof task === "string" && Object.prototype.hasOwnProperty.call(SCOUT_PROMPTS, task);
}

/** First JSON object in a model reply (handles ```json fences). */
export function parseJsonObject(content: unknown): Record<string, unknown> | null {
  if (typeof content !== "string") return null;
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** One model call for a scout task. Returns the parsed JSON object, or null on any failure. */
export async function runScoutTask(
  apiKey: string | undefined | null,
  task: ScoutTask,
  payload: unknown,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await aiGatewayFetch(apiKey, {
      model: "google/gemini-2.5-flash",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${SCOUT_PROMPTS[task]}\n\nINPUT:\n${JSON.stringify(payload ?? {}).slice(0, 20_000)}` },
      ],
    }, { label: `ai_task:${task}`, timeoutMs: 45_000, fetchImpl });
    if (!res.ok) {
      console.error(`[scout] ${task} AI error ${res.status}`);
      return null;
    }
    const data = await res.json();
    return parseJsonObject(data?.choices?.[0]?.message?.content);
  } catch (e) {
    console.error(`[scout] ${task} failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}
