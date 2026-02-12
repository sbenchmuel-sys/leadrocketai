// Unified Draft Generator — single entry point for all draft generation
import { supabase } from "@/integrations/supabase/client";
import type { AITaskType } from "@/hooks/useAITask";
import type { Motion } from "@/lib/dashboardUtils";
import { contextResolver, type ResolvedContext } from "@/lib/contextResolver";
import { playbookResolver, type PlaybookRecommendation } from "@/lib/playbookResolver";
import { scoreAndSelectModel, type AIModel } from "@/lib/complexityScorer";
import { formatWorkspaceContext } from "@/lib/workspaceProfileQueries";
import { getPlaybookById } from "@/lib/playbooks/registry";
import { formatPlaybookContext } from "@/lib/playbooks/formatPlaybookContext";

// ============================================
// TYPES
// ============================================

export interface GenerateDraftInput {
  lead_id: string;
  channel?: "email" | "linkedin" | "whatsapp";
  override_intent?: AITaskType | null;
  instructions?: string | null;
  motion_override?: Motion | null;
}

export interface DraftPipelineResult {
  resolved_context: ResolvedContext;
  playbook: PlaybookRecommendation;
  recommended_intent: AITaskType;
  recommended_playbook: string;
  sequence_step: string;
  draft_text: string | null;
  suggested_subject: string | null;
  // Complexity + model
  complexity_score: number;
  model_used: AIModel;
  scoring_factors: { label: string; points: number }[];
}

// ============================================
// PROMPT PAYLOAD BUILDER
// ============================================

function buildLeadContext(ctx: ResolvedContext): string {
  const lead = ctx.lead;
  return [
    `Name: ${lead.name}`,
    `Company: ${lead.company}`,
    `Email: ${lead.email}`,
    `Motion: ${(lead as any).motion || "outbound_prospecting"}`,
    `Stage: ${lead.stage}`,
    lead.job_title ? `Title: ${lead.job_title}` : "",
    lead.industry ? `Industry: ${lead.industry}` : "",
    (lead as any).personal_notes ? `Notes: ${(lead as any).personal_notes}` : "",
  ].filter(Boolean).join("\n");
}

function buildRepContext(ctx: ResolvedContext): string {
  const rep = ctx.rep_profile;
  if (!rep) return "";
  return [
    `Sender Name: ${rep.full_name || "Sales Rep"}`,
    `Sender Title: ${rep.job_title || ""}`,
    `Sender Company: ${rep.company_name || ctx.workspace_profile?.company_name || ""}`,
    `Calendar Link: ${rep.calendar_link || ""}`,
  ].filter(Boolean).join("\n");
}

const MAX_CONTEXT_CHARS = 1200;

/** Sanitize a value to a plain string — strips raw JSON objects/arrays */
function sanitizeValue(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
  if (typeof v === 'object') {
    // Convert simple {text:"..."} to its text, otherwise skip
    if ('text' in v && typeof v.text === 'string') return v.text.trim();
    return ''; // drop raw JSON
  }
  return String(v).trim();
}

function trimBlock(text: string, max: number = MAX_CONTEXT_CHARS): string {
  // collapse excessive whitespace / blank lines
  const cleaned = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max - 3) + '...' : cleaned;
}

function formatIndustryContext(industryKb: any): string {
  if (!industryKb || typeof industryKb !== 'object') return '';
  const lines: string[] = ['=== INDUSTRY CONTEXT ==='];
  const seen = new Set<string>();
  const addLine = (line: string) => {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (trimmed && !seen.has(trimmed)) { seen.add(trimmed); lines.push(trimmed); }
  };
  if (industryKb.industry_label) addLine(`Industry: ${sanitizeValue(industryKb.industry_label)}`);
  if (Array.isArray(industryKb.typical_objections) && industryKb.typical_objections.length > 0) {
    addLine('Typical Objections:');
    industryKb.typical_objections.slice(0, 5).forEach((o: any) => { const s = sanitizeValue(o); if (s) addLine(`- ${s}`); });
  }
  if (Array.isArray(industryKb.buying_signals) && industryKb.buying_signals.length > 0) {
    addLine('Buying Signals:');
    industryKb.buying_signals.slice(0, 5).forEach((s: any) => { const v = sanitizeValue(s); if (v) addLine(`- ${v}`); });
  }
  if (Array.isArray(industryKb.red_flags) && industryKb.red_flags.length > 0) {
    addLine('Red Flags:');
    industryKb.red_flags.slice(0, 5).forEach((f: any) => { const v = sanitizeValue(f); if (v) addLine(`- ${v}`); });
  }
  if (Array.isArray(industryKb.jargon) && industryKb.jargon.length > 0) {
    addLine(`Jargon: ${industryKb.jargon.slice(0, 8).map(sanitizeValue).filter(Boolean).join(', ')}`);
  }
  if (Array.isArray(industryKb.email_intents) && industryKb.email_intents.length > 0) {
    addLine('Suggested Email Intents:');
    industryKb.email_intents.slice(0, 4).forEach((i: any) => { const v = sanitizeValue(i); if (v) addLine(`- ${v}`); });
  }
  return trimBlock(lines.join('\n'));
}

function formatCompanyKbContext(companyKb: any): string {
  if (!companyKb || typeof companyKb !== 'object') return '';
  const lines: string[] = ['=== COMPANY KB ==='];
  const seen = new Set<string>();
  const addLine = (line: string) => {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (trimmed && !seen.has(trimmed)) { seen.add(trimmed); lines.push(trimmed); }
  };
  if (companyKb.company_name) addLine(`Company: ${sanitizeValue(companyKb.company_name)}`);
  if (companyKb.product_name) addLine(`Product: ${sanitizeValue(companyKb.product_name)}`);
  if (Array.isArray(companyKb.differentiators) && companyKb.differentiators.length > 0) {
    addLine('Differentiators:');
    companyKb.differentiators.slice(0, 5).forEach((d: any) => { const v = sanitizeValue(d); if (v) addLine(`- ${v}`); });
  }
  if (Array.isArray(companyKb.target_customers) && companyKb.target_customers.length > 0) {
    addLine('Target Customers:');
    companyKb.target_customers.slice(0, 5).forEach((t: any) => { const v = sanitizeValue(t); if (v) addLine(`- ${v}`); });
  }
  if (Array.isArray(companyKb.proof_points) && companyKb.proof_points.length > 0) {
    addLine('Proof Points:');
    companyKb.proof_points.slice(0, 5).forEach((p: any) => { const v = sanitizeValue(p); if (v) addLine(`- ${v}`); });
  }
  if (Array.isArray(companyKb.competitors) && companyKb.competitors.length > 0) {
    addLine(`Competitors: ${companyKb.competitors.slice(0, 5).map(sanitizeValue).filter(Boolean).join(', ')}`);
  }
  return trimBlock(lines.join('\n'));
}

// Cold outreach style blocks — injected for outbound first-touch emails
const COLD_OUTREACH_STYLE_BLOCK = `
=== MOTION: OUTBOUND FIRST TOUCH ===
Objective:
Trigger a reply. Not to close. Not to fully explain the product.

Structure Constraints:
- Maximum 90 words.
- Maximum 5 short paragraphs.
- One clear idea.
- One CTA only.
- No feature lists.
- No attachments.
- No calendar links in first email.

KB Usage:
- Use knowledge only to align positioning.
- Do NOT include case studies or metrics unless highly specific to the prospect.

CTA Requirements:
- Use a low-friction micro-commitment question.
- Make replying easy.

Avoid:
- Long intros, company history, multiple CTAs
- Generic "just checking in"

Psychology:
- Reduce pressure, signal relevance, leave room for correction
`;

const COLD_OUTREACH_SAAS_BLOCK = `
=== OUTBOUND STYLE: STANDARD ===
Opening:
- Professional and direct.
- Brief reason for reaching out.
- Optional light personalization.

Tone:
- Clear
- Confident
- Business-focused

Avoid:
- Humor
- Pattern interrupts
- Emotional tension framing
`;

const COLD_OUTREACH_HIGH_REPLY_BLOCK = `
=== OUTBOUND STYLE: HIGH REPLY ===
Opening Adjustment:
- Begin with a short disarming line such as:
  "Quick one —"
  OR a focused question.
  OR a clear problem hypothesis.
- Prefer question-first structure.
- Keep opening under 2 short lines.
- Introduce mild tension around a likely pain point.

Do NOT:
- Add humor unless clearly appropriate.
- Use sarcasm.
- Increase total word count.
- Change compliance tone.
`;

const INBOUND_RESPONSE_BLOCK = `
=== MOTION: INBOUND RESPONSE ===
Objective:
Convert interest into a scheduled conversation.

Structure:
- Acknowledge the context or question directly.
- Provide one helpful and relevant detail.
- Offer a clear next step.

Length:
- Up to 150 words allowed.

Tone:
- Consultative
- Helpful
- Slightly more detailed than outbound

CTA:
- Propose a specific next action (meeting, call, details).
`;

const REPLY_PATTERNS_BLOCK = `
=== REPLY OPTIMIZATION PATTERNS ===
Rotate one of these CTA patterns per email to maximize reply probability:

Permission-Based: "If this isn't relevant, feel free to say so — I'll close the loop."
Soft Assumption: "If this is already handled internally, happy to step aside."
Binary Micro-CTA: "Would you say this is: A) Relevant now B) Worth revisiting later C) Not a priority"
Curiosity Close: "Worth sharing how we've approached this with similar teams?"

Rules:
- Use ONE pattern per email, do not stack
- Match pattern to deal stage (permission-based for breakups, curiosity for early touches)
- Keep the CTA as the final sentence
`;

// Playbook-specific breakup closers
const BREAKUP_CLOSERS: Record<string, string> = {
  b2b_saas: `Breakup style: "I haven't heard back, so I'll assume this isn't a priority right now. If I'm wrong, happy to reconnect. Either way — appreciate the time."`,
  general_sales: `Breakup style: "Seems like timing may not be right. Should I close the loop for now?"`,
};

// Map playbook IDs to specialized outreach blocks (fallback to universal)
const PLAYBOOK_OUTREACH_BLOCKS: Record<string, string> = {
  b2b_saas: COLD_OUTREACH_SAAS_BLOCK,
  high_reply: COLD_OUTREACH_HIGH_REPLY_BLOCK,
};

// Determine if cold outreach style should be injected
// Only for: outbound_prospecting, no prior replies, first or second touch
function shouldInjectOutreachStyle(ctx: ResolvedContext, taskType: AITaskType): boolean {
  const motion = (ctx.lead as any).motion || "outbound_prospecting";
  if (motion !== "outbound_prospecting") return false;
  const noInbound = !ctx.last_inbound_email;
  const isEarlyTouch = taskType === "pre_email_1_intro" || taskType === "email_intro_fast" || taskType === "pre_email_2_followup";
  return noInbound && isEarlyTouch;
}

function isBreakupEmail(taskType: AITaskType): boolean {
  return taskType === "pre_email_4_breakup";
}

function getColdOutreachBlock(playbookId: string): string {
  return PLAYBOOK_OUTREACH_BLOCKS[playbookId] || COLD_OUTREACH_STYLE_BLOCK;
}

function buildAIPayload(
  ctx: ResolvedContext,
  taskType: AITaskType,
  instructions: string | null
): Record<string, unknown> {
  const lead = ctx.lead;

  const industryContext = formatIndustryContext(ctx.industry_kb);
  const companyKbContext = formatCompanyKbContext((ctx.workspace_profile as any)?.company_kb);

  // Resolve playbook
  const playbookId = (ctx.workspace_profile as any)?.industry_playbook_id || "general_sales";
  const playbook = getPlaybookById(playbookId);
  const playbookContext = formatPlaybookContext(playbook);

  // Cold outreach style injection — uses playbook-specific block if available
  const coldOutreachBlock = shouldInjectOutreachStyle(ctx, taskType) ? getColdOutreachBlock(playbookId) : "";

  // Inbound response motion block
  const motion = (ctx.lead as any).motion || "outbound_prospecting";
  const inboundBlock = motion === "inbound_response" ? INBOUND_RESPONSE_BLOCK : "";

  // Breakup email enhancement
  const breakupCloser = isBreakupEmail(taskType) ? (BREAKUP_CLOSERS[playbookId] || BREAKUP_CLOSERS.general_sales) : "";

  // Reply pattern injection for follow-ups (not first touch, not late-stage)
  const replyPatterns = (taskType === "pre_email_2_followup" || taskType === "pre_email_3_followup" || taskType === "pre_email_4_breakup") ? REPLY_PATTERNS_BLOCK : "";

  // LinkedIn tasks use a different payload shape
  if (taskType === "linkedin_connect" || taskType === "linkedin_followup") {
    return {
      prospect_name: lead.name,
      title: lead.job_title || "",
      company: lead.company !== "Unknown Company" ? lead.company : "",
      context: [
        lead.industry ? `Industry: ${lead.industry}` : "",
        lead.initial_message ? `Their message: ${lead.initial_message}` : "",
        (lead as any).personal_notes ? `Notes: ${(lead as any).personal_notes}` : "",
        instructions ? `Instructions: ${instructions}` : "",
      ].filter(Boolean).join(". ") || `B2B sales outreach`,
      knowledge_context: formatWorkspaceContext(ctx.workspace_profile),
      industry_context: industryContext,
      company_kb_context: companyKbContext,
      playbook_context: playbookContext,
    };
  }

  // WhatsApp tasks use a lightweight payload
  if (taskType === "whatsapp_message") {
    return {
      lead_context: buildLeadContext(ctx),
      custom_instructions: instructions || undefined,
      knowledge_context: formatWorkspaceContext(ctx.workspace_profile),
      industry_context: industryContext,
      company_kb_context: companyKbContext,
      playbook_context: playbookContext,
    };
  }

  const payload: Record<string, unknown> = {
    lead_id: lead.id,
    lead_context: buildLeadContext(ctx),
    rep_context: buildRepContext(ctx),
    workspace_context: formatWorkspaceContext(ctx.workspace_profile),
    industry_context: industryContext,
    company_kb_context: companyKbContext,
    playbook_context: [playbookContext, coldOutreachBlock, inboundBlock, replyPatterns, breakupCloser].filter(Boolean).join("\n"),
    meeting_link: lead.meeting_link || ctx.rep_profile?.calendar_link || "",
    custom_instructions: instructions || undefined,
  };

  // Thread context for replies
  if (ctx.thread_emails.length > 0 && taskType === "reply_to_thread") {
    payload.email_thread = ctx.thread_summary;
    payload.latest_inbound = ctx.last_inbound_email?.body_text || "";
  }

  // Lead card context for new outreach
  if (ctx.thread_emails.length === 0 && (lead as any).initial_message) {
    payload.lead_card_message = (lead as any).initial_message;
  }

  // Previous email summary for follow-ups
  if (taskType.includes("pre_email")) {
    payload.previous_email_summary = ctx.thread_summary || "No previous emails sent yet.";
  }

  // Nurture emails
  if (taskType === "nurture_email_single") {
    payload.theme = ctx.nurture_theme || "use_case";
    payload.email_number = ctx.nurture_outbound_count + 1;
    payload.previous_emails = ctx.thread_summary || "";
  }

  // Post-meeting follow-ups
  if (taskType === "post_meeting_followup_email") {
    const bullets = ctx.last_meeting_summary?.internal_recap_bullets;
    payload.meeting_summary_brief = Array.isArray(bullets)
      ? (bullets as string[]).join(". ")
      : "Recent meeting with lead.";
    payload.previous_emails = ctx.thread_summary || "";
    payload.last_outbound = ctx.last_outbound_email?.body_text || "";
  }

  return payload;
}

// ============================================
// SUBJECT DERIVATION
// ============================================

function deriveSubject(ctx: ResolvedContext, taskType: AITaskType): string {
  const leadFirstName = ctx.lead.name.split(" ")[0];
  const company = ctx.lead.company !== "Unknown Company" ? ctx.lead.company : null;

  if (taskType === "reply_to_thread" && ctx.thread_emails[0]?.subject) {
    return `Re: ${ctx.thread_emails[0].subject.replace(/^Re:\s*/i, "")}`;
  }
  if (taskType === "post_meeting_followup_email") {
    return `Following up on our conversation${company ? ` - ${company}` : ""}`;
  }
  if (taskType === "pre_email_2_followup") return `Following up - ${leadFirstName}`;
  if (taskType === "pre_email_3_followup") return `Checking in - ${leadFirstName}`;
  if (taskType === "pre_email_4_breakup") return `Closing the loop - ${leadFirstName}`;
  if (taskType === "nurture_email_single") {
    return `Thought you'd find this valuable${company ? `, ${leadFirstName}` : ""}`;
  }

  return company ? `Introduction - ${company}` : `Connecting with you, ${leadFirstName}`;
}

// ============================================
// PLACEHOLDER RESOLUTION
// ============================================

export function resolveEmailPlaceholders(text: string, repName: string | null): string {
  const firstName = repName?.split(" ")[0] || "";
  return text
    .replace(/\{Rep'?s?\s*first\s*name\}/gi, firstName)
    .replace(/\[Rep'?s?\s*first\s*name\]/gi, firstName)
    .replace(/\{Your\s*Name\}/gi, firstName)
    .replace(/\[Your\s*Name\]/gi, firstName)
    .replace(/\{Sender\s*Name\}/gi, firstName)
    .replace(/\[Sender\s*Name\]/gi, firstName)
    .replace(/\{First\s*Name\}/gi, firstName)
    .replace(/\[First\s*Name\]/gi, firstName);
}

// ============================================
// MAIN ORCHESTRATOR
// ============================================

export async function generateDraft(input: GenerateDraftInput): Promise<DraftPipelineResult> {
  const { lead_id, channel = "email", override_intent, instructions, motion_override } = input;

  console.log("[generateDraft] Starting pipeline for lead", lead_id);

  // Step 1: Resolve context
  const resolvedContext = await contextResolver(lead_id);

  // Apply motion override if provided
  if (motion_override && motion_override !== resolvedContext.motion) {
    console.log("[generateDraft] Motion override:", resolvedContext.motion, "→", motion_override);
    (resolvedContext as any).motion = motion_override;
  }

  // Step 2: Determine playbook (channel-aware)
  const playbook = playbookResolver(resolvedContext, channel);

  // Step 3: Apply override intent if provided
  const finalIntent = override_intent || playbook.recommended_intent;

  // Step 4: Complexity scoring + model selection
  const complexity = scoreAndSelectModel(resolvedContext, finalIntent, channel, instructions);

  console.log("[generateDraft] Recommended:", {
    intent: playbook.recommended_intent,
    playbook: playbook.recommended_playbook,
    step: playbook.next_sequence_step,
    finalIntent: override_intent ? `${finalIntent} (override)` : finalIntent,
  });

  console.log("[generateDraft] Complexity:", {
    score: complexity.complexity_score,
    model: complexity.model_used,
    factors: complexity.scoring_factors.map((f) => `${f.label} (+${f.points})`).join(", "),
  });

  // Step 5: Build structured prompt payload
  const aiPayload = buildAIPayload(resolvedContext, finalIntent, instructions || null);

  // Step 6: Call AI edge function
  let draftText: string | null = null;
  try {
    const { data, error } = await supabase.functions.invoke("ai_task", {
      body: { task: finalIntent, payload: aiPayload },
    });

    if (error) {
      console.error("[generateDraft] AI task error:", error);
    } else if (data?.ok && data?.content) {
      draftText = resolveEmailPlaceholders(
        data.content,
        resolvedContext.rep_profile?.full_name || null
      );
    } else {
      console.warn("[generateDraft] AI task returned no content:", data);
    }
  } catch (err) {
    console.error("[generateDraft] AI invocation failed:", err);
  }

  // Step 7: Derive subject
  const suggestedSubject = deriveSubject(resolvedContext, finalIntent);

  const result: DraftPipelineResult = {
    resolved_context: resolvedContext,
    playbook,
    recommended_intent: finalIntent,
    recommended_playbook: playbook.recommended_playbook,
    sequence_step: playbook.next_sequence_step,
    draft_text: draftText,
    suggested_subject: suggestedSubject,
    complexity_score: complexity.complexity_score,
    model_used: complexity.model_used,
    scoring_factors: complexity.scoring_factors,
  };

  console.log("[generateDraft] Complete:", {
    hasDraft: !!draftText,
    subject: suggestedSubject,
    intent: finalIntent,
  });

  return result;
}
