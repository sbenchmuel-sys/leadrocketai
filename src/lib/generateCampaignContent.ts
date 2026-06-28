// ============================================================================
// CAMPAIGN CONTENT ORCHESTRATOR (Outreach Unit B, Phase 2)
//
// Drives AI generation of the full cadence's ready-to-use copy and saves it to
// campaign_step_content. ALL generation routes through the ai_task edge function
// (no new AI caller) — this file only orchestrates which touch/variant to
// generate when, parses the single `content` response, and persists it.
//
// Key rules (from the build brief):
//  • A "couple of options" per touch = TWO SEQUENTIAL ai_task calls (the ai_task
//    response contract is single-`content` and stays that way). Stored in
//    options_json; the rep picks one.
//  • EDITS ARE SACRED: a touch with is_edited=true is skipped by bulk generation
//    and only an explicit per-touch Rewrite (force) regenerates it. Picking an
//    option never wipes an edit (enforced in selectStepOption / the UI).
//  • HYBRID TIMING: the caller generates the PRIMARY industry (most common
//    leads.industry among enrolled People) up front for every touch; other
//    industries are generated on demand. General campaigns have a single
//    variant (variant_group = null).
//  • Per-touch content by channel: email = subject + body; call = talking points
//    + a voicemail script for the no-answer leave-behind; SMS = one line.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";
import type { CanonicalChannel } from "@/lib/channels";
import {
  fetchStepContent,
  upsertStepContent,
  updateCampaign,
  type CampaignWithSteps,
  type CampaignStep,
  type CampaignLead,
  type StepContent,
  type StepContentOption,
} from "@/lib/campaignQueries";

export const OPTIONS_PER_TOUCH = 2;
// Above this many distinct industries, the UI warns that per-industry
// generation would be unwieldy (the brief: "keep it to a handful").
export const MAX_REASONABLE_INDUSTRIES = 6;

export type ContentKind = "email" | "voice" | "sms" | "other";

export function contentKindForChannel(channel: CanonicalChannel): ContentKind {
  if (channel === "email") return "email";
  if (channel === "voice") return "voice";
  if (channel === "sms") return "sms";
  return "other";
}

// ── Channel → ai_task task selection ────────────────────────────────────────
// Email touches REUSE the existing cold-sequence prompts, keyed by step_type.
function emailTaskForStep(step: CampaignStep): string {
  switch (step.step_type) {
    case "intro":
      return "pre_email_1_intro";
    case "breakup":
      return "pre_email_4_breakup";
    case "value_add":
      return "pre_email_3_followup";
    default:
      return "pre_email_2_followup"; // followup / nurture / re_engagement / ...
  }
}

// LinkedIn touches REUSE the existing short-form LinkedIn prompts, keyed by
// step_type: intro = connection request, value_add = react-to-their-post comment,
// everything else = a follow-up message. LinkedIn is always a MANUAL touch.
function linkedinTaskForStep(step: CampaignStep): string {
  switch (step.step_type) {
    case "intro":
      return "linkedin_connect";
    case "value_add":
      return "linkedin_reaction";
    default:
      return "linkedin_followup";
  }
}

export function primaryTaskForChannel(step: CampaignStep): string {
  switch (step.channel) {
    case "email":
      return emailTaskForStep(step);
    case "voice":
      return "cold_call_talking_points";
    case "sms":
      return "sms_message";
    case "whatsapp":
      return "whatsapp_message";
    case "linkedin":
      return linkedinTaskForStep(step);
    default:
      return emailTaskForStep(step);
  }
}

// ── Prompt inputs ───────────────────────────────────────────────────────────
function buildLeadContext(industry: string | null): string {
  const who = industry
    ? `cold prospects in the ${industry} industry`
    : "cold prospects (industry not specified)";
  return [
    `Audience: ${who}.`,
    "This is a REUSABLE template for many recipients — use {FirstName} for the recipient's first name and {Company} for their company. Do not invent a specific person's name.",
  ].join("\n");
}

function authoringInstructions(channel: CanonicalChannel, industry: string | null): string {
  const variantNote = industry ? ` Tailor it to the ${industry} industry.` : "";
  if (channel === "email") {
    // Body only — the subject is generated separately via cold_email_subject so
    // it isn't eaten by the body-task greeting repair (EMAIL_BODY_TASKS).
    return (
      "Write the BODY of a reusable cold-email TEMPLATE — no subject line." +
      variantNote +
      " Use {FirstName} and {Company} placeholders for personalization — never a made-up name."
    );
  }
  if (channel === "sms") {
    return "Write a reusable SMS template." + variantNote + " Use {FirstName} where the name belongs.";
  }
  if (channel === "voice") {
    return "Write reusable talking points." + variantNote + " Use {FirstName} and {Company} placeholders.";
  }
  return "Write a reusable template." + variantNote + " Use {FirstName} and {Company} placeholders.";
}

// Instructions for the dedicated subject task — deliberately NOT the body-only
// authoringInstructions (which say "no subject line"). The cold_email_subject
// prompt carries all the real rules; this just adds light industry tailoring.
function subjectInstructions(industry: string | null): string {
  return industry ? `Tailor the subject to the ${industry} industry.` : "";
}

// The LinkedIn prompts (linkedin_connect / linkedin_reaction / linkedin_followup)
// address a prospect directly via {{CONTEXT}} — they do NOT read custom_instructions.
// For a REUSABLE template we feed placeholder tokens ({FirstName}) instead of a real
// name and pack the authoring intent + offer into the context. The reaction variant
// is the only genuinely new instruction: a short suggested comment for the rep to
// adapt to the prospect's recent post (plain language — never "reaction intent").
function linkedinAuthoringContext(step: CampaignStep, industry: string | null, offer: string): string {
  const audience = industry ? ` Audience: ${industry} prospects.` : "";
  let intent: string;
  switch (step.step_type) {
    case "intro":
      intent = "This is a LinkedIn connection request — a short, no-pressure note with a genuine reason to connect, no pitch.";
      break;
    case "value_add":
      intent = "This is a suggested comment the rep will adapt to react to the prospect's most recent LinkedIn post — short, specific, genuine, no pitch.";
      break;
    default:
      intent = "This is a LinkedIn follow-up message — friendly, one light question, no hard pitch.";
  }
  return [
    intent + audience,
    offer ? `Offer context: ${offer}` : "",
    "Reusable template for many recipients — use {FirstName} for the prospect's first name; never invent a name.",
  ].filter(Boolean).join(" ");
}

interface AuthoringPayload {
  campaign_id: string;
  step_number: number;
  industry?: string;
  motion: string;
  first_touch: boolean;
  channel: CanonicalChannel;
  lead_context: string;
  offer_summary: string;
  custom_instructions: string;
  // LinkedIn template vars — only set for linkedin touches (the LinkedIn prompts
  // read these instead of custom_instructions). Harmless on other channels: the
  // edge function strips any unreferenced {{VAR}} placeholder.
  prospect_name?: string;
  title?: string;
  company?: string;
  context?: string;
  knowledge_context?: string;
}

// The intro email is the FIRST active email step, even if a call/text/LinkedIn touch
// precedes it; for non-email steps "first touch" is just step 1. This drives motion/
// style framing for BOTH the body and the separately-generated subject (cold_email_subject),
// so neither is framed as a follow-up when it's actually the intro email.
function isIntroTouch(campaign: CampaignWithSteps, step: CampaignStep): boolean {
  if (step.channel !== "email") return step.step_number === 1;
  const firstEmail = [...campaign.steps]
    .filter((s) => s.active && s.channel === "email")
    .sort((a, b) => a.step_number - b.step_number)[0];
  return !!firstEmail && firstEmail.step_number === step.step_number;
}

function authoringPayload(
  campaign: CampaignWithSteps,
  step: CampaignStep,
  industry: string | null,
): AuthoringPayload {
  const isLinkedIn = step.channel === "linkedin";
  return {
    campaign_id: campaign.id,
    step_number: step.step_number,
    industry: industry || undefined,
    motion: campaign.motion,
    first_touch: isIntroTouch(campaign, step),
    channel: step.channel,
    lead_context: buildLeadContext(industry),
    offer_summary: campaign.global_instructions || "",
    custom_instructions: authoringInstructions(step.channel, industry),
    ...(isLinkedIn
      ? {
          prospect_name: "{FirstName}",
          title: "",
          company: "{Company}",
          context: linkedinAuthoringContext(step, industry, campaign.global_instructions || ""),
          knowledge_context: campaign.global_instructions || "",
        }
      : {}),
  };
}

// ── ai_task invocation ──────────────────────────────────────────────────────
export interface GenerationError extends Error {
  retriable: true;
}

async function callAiTask(
  task: string,
  payload: AuthoringPayload,
): Promise<{ content: string; spamRisk: number | null }> {
  const { data, error } = await supabase.functions.invoke("ai_task", {
    body: { task, payload },
  });
  if (error) {
    const e = new Error(error.message || "Generation failed") as GenerationError;
    e.retriable = true;
    throw e;
  }
  if (!data?.ok || typeof data?.content !== "string" || !data.content.trim()) {
    const e = new Error((data && data.error) || "The AI returned no content — try again.") as GenerationError;
    e.retriable = true;
    throw e;
  }
  const spamRisk =
    data?.quality_score && typeof data.quality_score.spam_risk === "number"
      ? (data.quality_score.spam_risk as number)
      : null;
  return { content: data.content.trim(), spamRisk };
}

// Defensive: strip a stray leading "Subject: …" line if a body task emits one
// (the subject is generated separately via cold_email_subject).
function cleanEmailBody(content: string): string {
  const m = content.match(/^\s*subject:\s*.+?(?:\n+|$)/i);
  if (m) {
    const rest = content.slice(m[0].length).trim();
    if (rest) return rest;
  }
  return content;
}

// Normalize a generated subject: first non-empty line, no quotes / "Subject:" prefix.
function cleanSubject(content: string): string {
  const firstLine = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return firstLine
    .replace(/^subject:\s*/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
}

function optionFromContent(channel: CanonicalChannel, content: string): StepContentOption {
  if (channel === "email") return { body: cleanEmailBody(content) };
  if (channel === "voice") return { talking_points: content };
  if (channel === "sms") return { sms_text: content };
  return { body: content }; // whatsapp / other → rendered as a plain body block
}

// ── Per-touch generation ────────────────────────────────────────────────────
export interface GeneratedTouch {
  options: StepContentOption[];
  voicemail: string | null;
  spamRisk: number | null;
}

async function generateOptionsForTouch(
  campaign: CampaignWithSteps,
  step: CampaignStep,
  industry: string | null,
): Promise<GeneratedTouch> {
  const channel = step.channel;
  const primaryTask = primaryTaskForChannel(step);
  const base = authoringPayload(campaign, step, industry);

  const options: StepContentOption[] = [];
  let spamRisk: number | null = null;

  // Two SEQUENTIAL calls — a couple of distinct options for the rep to pick from.
  const isLinkedIn = channel === "linkedin";
  for (let i = 0; i < OPTIONS_PER_TOUCH; i++) {
    const variantNote =
      i === 0
        ? ""
        : " Give a meaningfully DIFFERENT option from a typical first attempt — fresh angle and a different opening line.";
    // LinkedIn prompts read {{CONTEXT}}, not {{CUSTOM_INSTRUCTIONS}}, so the
    // "make it different" nudge for option 2 has to ride on context there.
    const overrides = isLinkedIn
      ? { context: (base.context ?? "") + variantNote }
      : { custom_instructions: base.custom_instructions + variantNote };
    const { content, spamRisk: sr } = await callAiTask(primaryTask, { ...base, ...overrides });
    if (i === 0) spamRisk = sr;
    options.push(optionFromContent(channel, content));
  }

  // Email subject — generated once via a dedicated task (body tasks return body
  // only, and the body greeting-repair would eat an embedded "Subject:" line).
  // Use SUBJECT-specific instructions, not `base` — base.custom_instructions
  // says "write the body, no subject line", which would fight the subject task.
  // Best-effort: if it fails, the rep can type a subject in the review UI.
  if (channel === "email") {
    try {
      const subj = await callAiTask("cold_email_subject", {
        ...base,
        custom_instructions: subjectInstructions(industry),
      });
      const subject = cleanSubject(subj.content);
      if (subject) for (const o of options) o.subject = subject;
    } catch {
      /* subject is best-effort — leave it blank rather than failing the touch */
    }
  }

  // Call touches also get a voicemail script (the no-answer leave-behind).
  let voicemail: string | null = null;
  if (channel === "voice") {
    const vm = await callAiTask("cold_voicemail", authoringPayload(campaign, step, industry));
    voicemail = vm.content;
  }

  return { options, voicemail, spamRisk };
}

function flatFieldsFromOption(opt: StepContentOption) {
  return {
    subject: opt.subject ?? null,
    body: opt.body ?? null,
    talking_points: opt.talking_points ?? null,
    sms_text: opt.sms_text ?? null,
  };
}

/**
 * Generate (or regenerate) one touch+variant and persist it. Bulk generation
 * (force=false) never overwrites a touch that already has content — it only
 * fills gaps — so a rep's edits (and earlier picks) are safe. Only an explicit
 * per-touch Rewrite (force=true) regenerates an existing touch. Returns false
 * when nothing was written.
 */
export async function generateTouch(
  campaign: CampaignWithSteps,
  step: CampaignStep,
  industry: string | null,
  opts: { force?: boolean; existing?: StepContent | null } = {},
): Promise<boolean> {
  if (opts.existing && !opts.force) return false;

  const { options, voicemail } = await generateOptionsForTouch(campaign, step, industry);
  const first = options[0] ?? {};

  await upsertStepContent(campaign.id, step.step_number, industry, {
    ...flatFieldsFromOption(first),
    voicemail_script: voicemail,
    options_json: options,
    selected_option: 0,
    is_edited: false,
  });
  return true;
}

// ── Whole-cadence generation for one variant ────────────────────────────────
export interface GenerateAllProgress {
  done: number;
  total: number;
  step: CampaignStep;
  skipped: boolean;
}

/**
 * Generate every active touch for one variant (an industry, or null=General).
 * Sequential — respects the "couple of options" pacing and avoids hammering the
 * AI gateway. Skips rep-edited touches unless force is set.
 */
export async function generateAllTouches(
  campaign: CampaignWithSteps,
  industry: string | null,
  opts: { force?: boolean; onProgress?: (p: GenerateAllProgress) => void } = {},
): Promise<{ generated: number; skipped: number }> {
  const steps = [...campaign.steps].filter((s) => s.active).sort((a, b) => a.step_number - b.step_number);
  const existingRows = await fetchStepContent(campaign.id);
  const key = (v: string | null) => (v == null || v.trim() === "" ? "" : v);
  const wanted = key(industry);
  const byStep = new Map<number, StepContent>();
  for (const r of existingRows) {
    if (key(r.variant_group) === wanted) byStep.set(r.step_number, r);
  }

  let generated = 0;
  let skipped = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const existing = byStep.get(step.step_number) ?? null;
    const did = await generateTouch(campaign, step, industry, { force: opts.force, existing });
    if (did) generated++;
    else skipped++;
    opts.onProgress?.({ done: i + 1, total: steps.length, step, skipped: !did });
  }
  return { generated, skipped };
}

/** Force-regenerate a single touch (the per-touch "Rewrite" action). */
export async function rewriteTouch(
  campaign: CampaignWithSteps,
  step: CampaignStep,
  industry: string | null,
): Promise<void> {
  await generateTouch(campaign, step, industry, { force: true });
}

/**
 * One-tap "soften": regenerate this touch's selected copy with an explicit
 * anti-spam directive (calmer tone, fewer caps/exclamations/links). Replaces
 * the selected option's flat fields; leaves the alternate option intact so the
 * rep can still flip back. Advisory only — never invoked automatically.
 */
export async function softenTouch(
  campaign: CampaignWithSteps,
  step: CampaignStep,
  industry: string | null,
  current: StepContent,
): Promise<void> {
  const channel = step.channel;
  const base = authoringPayload(campaign, step, industry);
  const softer =
    base.custom_instructions +
    " IMPORTANT: keep it calm and human — no ALL-CAPS, at most one exclamation mark, no money symbols, no urgency or hype, minimal links. It must not read like spam.";
  const { content } = await callAiTask(primaryTaskForChannel(step), { ...base, custom_instructions: softer });
  const opt = optionFromContent(channel, content);

  // Soften regenerates only the PRIMARY content (email body / talking points /
  // sms). Preserve the companion fields it didn't touch so softening a body
  // doesn't delete the subject — or the voicemail on a call touch.
  if (channel === "email") {
    opt.subject = current.subject ?? (current.options_json?.[current.selected_option ?? 0]?.subject ?? undefined);
  }

  // Replace the currently selected option in options_json, and the flat fields.
  const idx = current.selected_option ?? 0;
  const options = Array.isArray(current.options_json) ? [...current.options_json] : [];
  if (options.length > idx) options[idx] = opt;
  else options.push(opt);

  await upsertStepContent(campaign.id, step.step_number, industry, {
    ...flatFieldsFromOption(opt),
    voicemail_script: current.voicemail_script, // unchanged by soften
    options_json: options,
    selected_option: idx,
    is_edited: false,
  });
}

// ── Industry helpers (hybrid timing inputs) ─────────────────────────────────
export interface IndustryCount {
  industry: string;
  count: number;
}

/** Distinct non-blank industries among enrolled leads, most common first. */
export function getIndustriesPresent(leads: CampaignLead[]): IndustryCount[] {
  const counts = new Map<string, number>();
  for (const l of leads) {
    const ind = l.industry?.trim();
    if (!ind) continue;
    counts.set(ind, (counts.get(ind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([industry, count]) => ({ industry, count }))
    .sort((a, b) => b.count - a.count || a.industry.localeCompare(b.industry));
}

/** The single most common industry among enrolled leads (the "primary"). */
export function computePrimaryIndustry(leads: CampaignLead[]): string | null {
  return getIndustriesPresent(leads)[0]?.industry ?? null;
}

// ── Knowledge-file ingestion ────────────────────────────────────────────────
// Pipe an uploaded, company-authored knowledge file through the existing
// process-knowledge-document edge function and record the resulting
// kb_chunks.document_id on the campaign so authoring-time KB retrieval is scoped
// to it. A stable `source` ("campaign:<id>") means re-uploading REPLACES the
// previous chunks rather than piling up.
//
// GUARDRAIL: only company-authored collateral (flyers, one-pagers, offer sheets)
// belongs here — it persists in kb_chunks indefinitely. NEVER pass customer
// email/message bodies through this path (it would dodge the 72h/7-day purge).
export async function ingestCampaignKnowledge(
  campaignId: string,
  text: string,
  fileName: string,
): Promise<string> {
  if (!text || text.trim().length < 50) {
    throw new Error(
      "That file didn't have enough readable text — it may be a scanned or image-only document. Try a text-based file.",
    );
  }
  const { data, error } = await supabase.functions.invoke("process-knowledge-document", {
    body: {
      text,
      title: fileName,
      source: `campaign:${campaignId}`,
      content_type: "knowledge",
      allowed_customer_facing: true,
    },
  });
  if (error) throw new Error(error.message || "Couldn't process that file");
  if (!data?.ok || !data?.document_id) {
    throw new Error((data && data.error) || "Couldn't process that file");
  }
  const documentId = data.document_id as string;
  await updateCampaign(campaignId, { knowledge_document_id: documentId, knowledge_ref: fileName });
  return documentId;
}

// ── Advisory spam heuristics (client-side, instant; never blocks) ───────────
// Complements the AI spam_risk returned by generation. Cheap checks the brief
// calls out: excessive $/!/ALL-CAPS, too many links, spammy subject.
export interface SpamHeuristic {
  level: "ok" | "heads_up";
  reasons: string[];
}

export function checkSpamHeuristics(subject: string | null, body: string | null): SpamHeuristic {
  const reasons: string[] = [];
  const text = `${subject || ""}\n${body || ""}`;

  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations >= 3) reasons.push("Lots of exclamation marks");

  const dollars = (text.match(/\$/g) || []).length;
  if (dollars >= 3) reasons.push("Several dollar signs");

  const links = (text.match(/https?:\/\//gi) || []).length;
  if (links >= 3) reasons.push("Several links");

  // ALL-CAPS words of 4+ letters (ignore short acronyms).
  const capsWords = (text.match(/\b[A-Z]{4,}\b/g) || []).length;
  if (capsWords >= 3) reasons.push("Lots of ALL-CAPS words");

  if (subject && /\b(free|act now|limited time|guarantee[d]?|urgent|cash)\b/i.test(subject)) {
    reasons.push("Spammy-sounding subject");
  }

  return { level: reasons.length > 0 ? "heads_up" : "ok", reasons };
}
