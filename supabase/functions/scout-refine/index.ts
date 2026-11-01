// scout-refine — Lead Scout setup: rewrite the target from 👍/👎 votes (+ reason
// chips) and/or the rep's own words ("skip banks, add ISOs"). One ai_task call
// (scout_refine_profile); output clamped to the profile_json schema, anchors
// limited to the rep's own leads already on the profile.
// No-op unless workspace_automation_settings.scout_enabled.
import { anchorNames, callScoutAi, openScoutRequest, ownedProfileId, scoutJson } from "../_shared/scoutGate.ts";
import { clampProfile, clampVotes, isEmptyProfile, profileSentence } from "../_shared/scoutProfile.ts";

Deno.serve(async (req) => {
  const r = await openScoutRequest(req);
  if (r instanceof Response) return r;
  try {
    if (!(await ownedProfileId(r, r.body.profile_id))) return scoutJson({ ok: false, error: "Profile not found" }, 404);

    // Anchors must be the rep's own leads: look them up, keep only what exists.
    // deno-lint-ignore no-explicit-any
    const rawIds = ((r.body.profile as any)?.anchor_lead_ids ?? []) as unknown[];
    const names = await anchorNames(r, rawIds.filter((id): id is string => typeof id === "string"));
    const current = clampProfile(r.body.profile, Object.keys(names));

    const votes = clampVotes(r.body.votes);
    const instruction = typeof r.body.instruction === "string" ? r.body.instruction.trim().slice(0, 500) : "";
    if (votes.length === 0 && !instruction) {
      return scoutJson({ ok: true, profile: current, profile_sentence: profileSentence(current, names), anchor_names: names, note: null });
    }

    const result = await callScoutAi("scout_refine_profile", { profile: current, votes, instruction });
    const next = clampProfile(result?.profile, current.anchor_lead_ids);
    if (!result || isEmptyProfile(next)) return scoutJson({ ok: false, reason: "ai_failed" });

    const note = typeof result.note === "string" ? result.note.replace(/\s+/g, " ").trim().slice(0, 120) || null : null;
    return scoutJson({ ok: true, profile: next, profile_sentence: profileSentence(next, names), anchor_names: names, note });
  } catch (e) {
    console.error("[scout-refine] error:", e instanceof Error ? e.message : e);
    return scoutJson({ ok: false, error: "Internal error" }, 500);
  }
});
