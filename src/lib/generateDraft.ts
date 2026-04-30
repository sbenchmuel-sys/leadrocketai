// Unified Draft Generator — single entry point for all draft generation
// Client-side: resolves context, determines intent, sends raw data to edge function
// All prompt assembly happens server-side in the edge function.
import { supabase } from "@/integrations/supabase/client";
import type { AITaskType } from "@/hooks/useAITask";
import type { Motion } from "@/lib/dashboardUtils";
import { contextResolver, type ResolvedContext } from "@/lib/contextResolver";
import { buildCampaignPayloadFields } from "@/lib/campaignResolver";
import { playbookResolver, type PlaybookRecommendation } from "@/lib/playbookResolver";
import { scoreAndSelectModel, type AIModel } from "@/lib/complexityScorer";
import { formatWorkspaceContext } from "@/lib/workspaceProfileQueries";

// ============================================
// TYPES
// ============================================

import type { RepProfile } from "@/lib/repProfileQueries";
import type { WorkspaceProfile } from "@/lib/workspaceProfileQueries";
import type { KnowledgeDocument } from "@/lib/repProfileQueries";
import type { ContextPrefetched } from "@/lib/contextResolver";

// ============================================
// DRAFT CACHE (5-minute in-memory)
// ============================================

const DRAFT_CACHE = new Map<string, { result: DraftPipelineResult; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedDraft(key: string): DraftPipelineResult | null {
  const entry = DRAFT_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { DRAFT_CACHE.delete(key); return null; }
  return entry.result;
}

function setCachedDraft(key: string, result: DraftPipelineResult): void {
  DRAFT_CACHE.set(key, { result, expires: Date.now() + CACHE_TTL });
}

export function clearDraftCache(leadId: string): void {
  for (const key of DRAFT_CACHE.keys()) {
    if (key.startsWith(`${leadId}::`)) {
      DRAFT_CACHE.delete(key);
    }
  }
}

export interface GenerateDraftInput {
  lead_id: string;
  channel?: "email" | "linkedin" | "whatsapp" | "sms";
  override_intent?: AITaskType | null;
  instructions?: string | null;
  motion_override?: Motion | null;
  // Optional pre-fetched data to skip duplicate DB round trips
  prefetched?: ContextPrefetched;
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
// CONTEXT BUILDERS (raw data only, no prompt blocks)
// ============================================

function buildLeadContext(ctx: ResolvedContext): string {
  const lead = ctx.lead;
  return [
    `Name: ${lead.name}`,
    `Company: ${lead.company}`,
    `Email: ${lead.email}`,
    `Motion: ${(lead as any).motion || "outbound_prospecting"}`,
    `Source: ${(lead as any).source_type || "manual_entry"}`,
    `Stage: ${lead.stage}`,
    lead.job_title ? `Title: ${lead.job_title}` : "",
    lead.industry ? `Industry: ${lead.industry}` : "",
    (lead as any).personal_notes ? `Notes: ${(lead as any).personal_notes}` : "",
  ].filter(Boolean).join("\n");
}

function buildRepContext(ctx: ResolvedContext): string {
  const rep = ctx.rep_profile;
  // Always provide a sender name — fall back to auth user metadata if rep profile is missing
  const senderName = rep?.full_name || getAuthUserName() || "Sales Rep";
  return [
    `Sender Name: ${senderName}`,
    rep?.job_title ? `Sender Title: ${rep.job_title}` : "",
    rep?.company_name || (ctx.workspace_profile as any)?.company_name
      ? `Sender Company: ${rep?.company_name || (ctx.workspace_profile as any)?.company_name || ""}`
      : "",
    rep?.calendar_link ? `Calendar Link: ${rep.calendar_link}` : "",
  ].filter(Boolean).join("\n");
}

/** Extract user display name from Supabase auth session (cached in memory) */
function getAuthUserName(): string | null {
  try {
    // supabase.auth stores session in memory after login — this is synchronous-safe
    const sessionStr = localStorage.getItem(
      Object.keys(localStorage).find(k => k.includes("supabase") && k.includes("auth")) || ""
    );
    if (!sessionStr) return null;
    const parsed = JSON.parse(sessionStr);
    const meta = parsed?.user?.user_metadata || parsed?.currentSession?.user?.user_metadata;
    return meta?.full_name || meta?.name || null;
  } catch {
    return null;
  }
}

// ============================================
// INSTRUCTION MERGE HELPER
// ============================================

/** @deprecated — Prefer buildCampaignPayloadFields() which uses the canonical resolver.
 *  Kept only for edge cases where no action_key context is available. */
function mergeInstructions(userInstructions: string | null, leadInstructions: string | null): string | null {
  if (!userInstructions && !leadInstructions) return null;
  if (!leadInstructions) return userInstructions;
  if (!userInstructions) return leadInstructions;
  return `${userInstructions}\n\n--- CAMPAIGN INSTRUCTIONS ---\n${leadInstructions}`;
}

// ============================================
// ACTION KEY INFERENCE (maps AI task type back to action_key for resolver)
// ============================================

function inferActionKey(taskType: AITaskType, ctx: ResolvedContext): string | null {
  const TASK_TO_ACTION: Record<string, string> = {
    pre_email_1_intro: "send_pre_1",
    pre_email_2_followup: "send_pre_2",
    pre_email_3_followup: "send_pre_3",
    pre_email_4_breakup: "send_pre_4",
    nurture_email_single: `nurture_${((ctx.lead as any).nurture_outbound_count || 0) + 1}`,
    re_engagement_intro: "send_pre_1",
    email_intro_fast: "send_pre_1",
    email_intro_nurture: "nurture_1",
    inbound_intro: "send_pre_1",
  };
  return TASK_TO_ACTION[taskType] || null;
}
// ============================================

function buildAIPayload(
  ctx: ResolvedContext,
  taskType: AITaskType,
  instructions: string | null
): Record<string, unknown> {
  const lead = ctx.lead;
  const motion = (lead as any).motion || "outbound_prospecting";

  // Determine metadata flags for edge function
  const playbookId = (ctx.workspace_profile as any)?.industry_playbook_id || "general_sales";
  const isFirstTouch = !ctx.last_outbound_email && !ctx.last_inbound_email;
  const hasLatestInbound = !!ctx.last_inbound_email;

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
      // Raw workspace context for edge function
      knowledge_context: formatWorkspaceContext(ctx.workspace_profile),
      // Metadata flags
      playbook_id: playbookId,
      motion,
      first_touch: isFirstTouch,
      has_latest_inbound: hasLatestInbound,
    };
  }

  // WhatsApp tasks use a lightweight payload
  if (taskType === "whatsapp_message") {
    return {
      lead_context: buildLeadContext(ctx),
      custom_instructions: instructions || undefined,
      knowledge_context: formatWorkspaceContext(ctx.workspace_profile),
      // Metadata flags
      playbook_id: playbookId,
      motion,
      first_touch: isFirstTouch,
      has_latest_inbound: hasLatestInbound,
    };
  }

  // Email payload — raw data only, no prompt blocks
  const payload: Record<string, unknown> = {
    lead_id: lead.id,
    lead_context: buildLeadContext(ctx),
    lead_card_message: lead.initial_message || "",
    rep_context: buildRepContext(ctx),
    workspace_context: formatWorkspaceContext(ctx.workspace_profile),
    meeting_link: lead.meeting_link || ctx.rep_profile?.calendar_link || "",
    custom_instructions: instructions || undefined,
    outbound_tone: (lead as any).outbound_tone || "direct",
    // Metadata flags for edge function prompt assembly
    playbook_id: playbookId,
    motion,
    first_touch: isFirstTouch,
    has_latest_inbound: hasLatestInbound,
  };

  // Cross-channel conversation history (SMS, WhatsApp, email, calls — everything)
  // This ensures the AI sees ALL communication before generating a response
  if (ctx.cross_channel_summary) {
    payload.cross_channel_history = ctx.cross_channel_summary;
  }

  // If latest inbound is from a non-email channel (SMS, WhatsApp), pass it as latest_inbound
  // so the AI knows to address it regardless of task type
  if (ctx.last_inbound_any_channel) {
    const anyInboundTime = new Date(ctx.last_inbound_any_channel.occurred_at).getTime();
    const emailInboundTime = ctx.last_inbound_email?.occurred_at
      ? new Date(ctx.last_inbound_email.occurred_at).getTime() : 0;
    // If the latest inbound from any channel is newer than the latest email inbound,
    // use it as the primary inbound context
    if (anyInboundTime > emailInboundTime) {
      payload.latest_inbound = ctx.last_inbound_any_channel.snippet;
      payload.latest_inbound_channel = ctx.last_inbound_any_channel.channel;
      payload.has_latest_inbound = true;
    }
  }

  // Thread context for replies
  if (ctx.thread_emails.length > 0 && taskType === "reply_to_thread") {
    payload.email_thread = ctx.thread_summary;
    // Staleness guard: only include latest_inbound if it's genuinely newer than last outbound
    // But don't overwrite if cross-channel inbound was already set above
    if (!payload.latest_inbound) {
      const inboundTime = ctx.last_inbound_email?.occurred_at;
      const outboundTime = ctx.last_outbound_email?.occurred_at;
      if (inboundTime && (!outboundTime || new Date(inboundTime) > new Date(outboundTime))) {
        payload.latest_inbound = ctx.last_inbound_email?.body_text || "";
      } else {
        payload.latest_inbound = ""; // prevent AI from addressing stale inbound
      }
    }
  }

  // Lead card context for new outreach
  if (ctx.thread_emails.length === 0 && (lead as any).initial_message) {
    payload.lead_card_message = (lead as any).initial_message;
  }

  // Previous email summary + re-engagement context for follow-ups
  if (taskType.includes("pre_email") || taskType === "re_engagement_intro") {
    payload.previous_email_summary = ctx.thread_summary || "No previous emails sent yet.";
    // Full last outbound for dedup
    payload.last_outbound_body = ctx.last_outbound_email?.body_text || "";
    // Intelligence signals for varied angles
    payload.buying_signals = ctx.buying_signals.length > 0 
      ? ctx.buying_signals.join(", ") : "None detected";
    payload.risk_signals = ctx.risk_signals.length > 0 
      ? ctx.risk_signals.join(", ") : "None detected";
    payload.engagement_level = ctx.engagement_level;
    // Milestones summary
    const milestones = ctx.lead.milestones_json as any[];
    payload.milestones = milestones?.length > 0
      ? milestones.map((m: any) => `${m.status}: ${m.description}`).join("; ")
      : "No milestones recorded";
    // Days since last activity
    if (ctx.lead.last_activity_at) {
      const days = Math.floor((Date.now() - new Date(ctx.lead.last_activity_at).getTime()) / (1000*60*60*24));
      payload.days_since_activity = String(days);
    }
    // Meeting context if available
    if (ctx.last_meeting_summary) {
      const bullets = ctx.last_meeting_summary.internal_recap_bullets;
      payload.meeting_context = Array.isArray(bullets) 
        ? (bullets as string[]).slice(0, 3).join(". ") : "";
    }
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

    // Staleness guard: if last outbound is newer than last inbound,
    // the AI should follow up on OUR email, not reply to stale inbound
    const inboundTime = ctx.last_inbound_email?.occurred_at;
    const outboundTime = ctx.last_outbound_email?.occurred_at;
    if (inboundTime && outboundTime && new Date(outboundTime) > new Date(inboundTime)) {
      payload.stale_inbound = true;
      payload.stale_inbound_instruction = `⚠️ STALE INBOUND WARNING: The prospect's last inbound email is OLDER than your last outbound. Do NOT respond to or reference the old inbound content. Instead, write a follow-up to YOUR most recent outbound email.`;
    } else {
      payload.stale_inbound_instruction = "";
    }
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
  if (taskType === "re_engagement_intro") return `Reconnecting - ${leadFirstName}`;
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

function sanitizeDraftContent(text: string, channel?: string): string {
  let cleaned = (text || "").trim();

  // Strip markdown fences if a model wraps output
  cleaned = cleaned
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Strip label-only prefixes like "Email body:" or "Body:" or "SMS:" or "Message:"
  cleaned = cleaned.replace(/^(?:email\s*body|body|sms|message|text\s*message)\s*:\s*/i, "").trim();

  // Guard against leaked reasoning blocks if model slips through
  if (/(?:INTERNAL\s+(?:REASONING|REFLECTION|ANALYSIS)|^Reasoning\s*:|^THOUGHT\s*:|^CHAIN\s*OF\s*THOUGHT)/im.test(cleaned)) {
    const lines = cleaned.split("\n");

    if (channel === "sms" || channel === "whatsapp") {
      // For short-form channels: strip all lines that look like reasoning,
      // then take whatever remains
      const reasoningEnd = lines.findIndex((line, i) => {
        const t = line.trim();
        // Skip empty lines and lines that look like reasoning
        if (!t) return false;
        if (/^(?:INTERNAL|Reasoning|THOUGHT|CHAIN|OUTPUT|FINAL|The user|The motion|The message|The lead|I need|I should|Let me|This is|Here)/i.test(t)) return false;
        if (t.endsWith(":") || t.startsWith("-") || t.startsWith("*")) return false;
        // This line looks like actual message content
        return i > 0;
      });
      if (reasoningEnd > 0) {
        cleaned = lines.slice(reasoningEnd).join("\n").trim();
      }
    } else {
      // For email: look for greeting-style start
      const emailStart = lines.findIndex((line) => {
        const t = line.trim();
        return (
          /^(?:Hi|Hey|Hello|Dear|Thanks|Thank you|Subject:)\b/i.test(t) ||
          /^[A-Z][a-z]{1,20},\s*$/.test(t)
        );
      });
      if (emailStart > 0) {
        cleaned = lines.slice(emailStart).join("\n").trim();
      }
    }
  }

  // For SMS: also strip any greeting/sign-off that slipped through
  if (channel === "sms") {
    // Remove greeting lines
    cleaned = cleaned.replace(/^(?:Hi|Hey|Hello|Dear)\s+\w+[,!]?\s*\n/i, "").trim();
    // Remove sign-off lines (Best, Thanks, Regards, name-only last line)
    cleaned = cleaned.replace(/\n\s*(?:Best|Thanks|Regards|Cheers|Sincerely)[,.]?\s*\n?.*$/i, "").trim();
  }

  // If model only returns the label, treat as empty
  if (/^(?:email\s*body|sms|message)\.?$/i.test(cleaned)) return "";

  return cleaned;
}

// ============================================
// STREAMING DRAFT GENERATOR
// ============================================

export interface StreamDraftInput extends GenerateDraftInput {
  onToken: (token: string) => void;
  onSubject: (subject: string) => void;
  onPipelineReady: (result: Omit<DraftPipelineResult, 'draft_text'>) => void;
}

export async function streamDraft(input: StreamDraftInput): Promise<DraftPipelineResult> {
  const { lead_id, channel = "email", override_intent, instructions, motion_override, prefetched, onToken, onSubject, onPipelineReady } = input;

  console.log("[streamDraft] Starting streaming pipeline for lead", lead_id);

  // Check cache first (keyed by lead + intent override + instructions)
  const cacheKey = `${lead_id}::${channel}::${override_intent || "auto"}::${instructions || ""}::${motion_override || ""}`;
  const cached = getCachedDraft(cacheKey);
  if (cached) {
    console.log("[streamDraft] Cache hit — serving cached draft instantly");
    onSubject(cached.suggested_subject || "");
    onPipelineReady(cached);
    // Stream the cached draft text token by token for consistent UX
    if (cached.draft_text) {
      const chunkSize = 50;
      for (let i = 0; i < cached.draft_text.length; i += chunkSize) {
        onToken(cached.draft_text.slice(i, i + chunkSize));
        await new Promise(r => setTimeout(r, 0)); // yield to UI
      }
    }
    return cached;
  }

  // Step 1: Resolve context (pass prefetched profiles to skip duplicate DB fetches)
  const resolvedContext = await contextResolver(lead_id, prefetched);

  // Apply motion override if provided
  if (motion_override && motion_override !== resolvedContext.motion) {
    console.log("[streamDraft] Motion override:", resolvedContext.motion, "→", motion_override);
    (resolvedContext as any).motion = motion_override;
    (resolvedContext.lead as any).motion = motion_override;
  }

  // Step 2: Determine playbook (channel-aware)
  const playbook = playbookResolver(resolvedContext, channel);

  // Step 3: Apply override intent if provided
  const finalIntent = override_intent || playbook.recommended_intent;

  // Step 4: Complexity scoring + model selection
  const complexity = scoreAndSelectModel(resolvedContext, finalIntent, channel, instructions);

   // Step 5: Build raw payload — merge lead's saved action_instructions with user-provided instructions
    const leadInstructions = (resolvedContext.lead as any).action_instructions as string | null;
    const mergedInstructions = mergeInstructions(instructions || null, leadInstructions);
    const aiPayload = buildAIPayload(resolvedContext, finalIntent, mergedInstructions);

    // Step 5b: Inject structured campaign resolver fields (matches automation-executor)
    const campaignFields = buildCampaignPayloadFields({
      action_key: inferActionKey(finalIntent, resolvedContext),
      motion: resolvedContext.motion || (resolvedContext.lead as any).motion || "outbound_prospecting",
      channel: channel === "linkedin" ? "email" : channel,
      outbound_tone: (resolvedContext.lead as any).outbound_tone || "direct",
      action_instructions: leadInstructions,
      has_reply: !!resolvedContext.last_inbound_email,
      meeting_booked: resolvedContext.lead.has_future_meeting,
      calendar_link: resolvedContext.rep_profile?.calendar_link || null,
    });
    aiPayload.campaign_instruction = campaignFields.campaign_instruction;
    aiPayload.campaign_meta = campaignFields.campaign_meta;

  // Derive subject immediately (no AI needed)
  const suggestedSubject = deriveSubject(resolvedContext, finalIntent);
  onSubject(suggestedSubject);

  // Notify caller of pipeline metadata before streaming starts
  const partialResult: Omit<DraftPipelineResult, 'draft_text'> = {
    resolved_context: resolvedContext,
    playbook,
    recommended_intent: finalIntent,
    recommended_playbook: playbook.recommended_playbook,
    sequence_step: playbook.next_sequence_step,
    suggested_subject: suggestedSubject,
    complexity_score: complexity.complexity_score,
    model_used: complexity.model_used,
    scoring_factors: complexity.scoring_factors,
  };
  onPipelineReady(partialResult);

  // Step 6: Ensure context cache exists — BLOCK for new leads so signals/angles are ready before LLM call
  const isFirstTouch = !resolvedContext.last_outbound_email && !resolvedContext.last_inbound_email;
  try {
    const { data: cacheCheck } = await supabase
      .from("lead_context_cache")
      .select("id")
      .eq("lead_id", lead_id)
      .maybeSingle();

    if (!cacheCheck) {
      console.log("[streamDraft] No context cache — triggering build", isFirstTouch ? "(BLOCKING for first-touch)" : "(fire-and-forget)");
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const { data: { session: s } } = await supabase.auth.getSession();
      const buildPromise = fetch(`${supabaseUrl}/functions/v1/build-lead-context`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s?.access_token || supabaseKey}`,
          apikey: supabaseKey,
        },
        body: JSON.stringify({ lead_id, force: true }),
      });

      if (isFirstTouch) {
        // BLOCK: wait for context cache to build so ai_task has signals + angles
        try {
          const resp = await buildPromise;
          if (resp.ok) {
            console.log("[streamDraft] ✅ Context cache built before draft generation");
          } else {
            console.warn("[streamDraft] Context cache build returned", resp.status);
          }
        } catch (err) {
          console.warn("[streamDraft] Context cache build failed, proceeding without:", err);
        }
      } else {
        buildPromise.catch(() => {}); // fire-and-forget for non-first-touch
      }
    }
  } catch { /* ignore cache check failures */ }

  // Step 7: Request finalized AI content (non-stream) for reliable post-processing
  // then emit it in UI-sized chunks for a streaming-like experience.
  let fullText = "";
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    
    // Get auth token
    const { data: { session } } = await supabase.auth.getSession();
    const authToken = session?.access_token || supabaseKey;

    const resp = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
        "apikey": supabaseKey,
      },
      body: JSON.stringify({
        task: finalIntent,
        payload: { ...aiPayload, model_hint: complexity.model_used },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[streamDraft] ai_task request failed:", resp.status, errText);
      throw new Error(`ai_task request failed: ${resp.status}`);
    }

    const aiData = await resp.json();
    if (!aiData?.ok || typeof aiData?.content !== "string") {
      console.error("[streamDraft] ai_task returned invalid payload:", aiData);
      throw new Error(aiData?.error || "ai_task returned invalid payload");
    }

    // Final cleanup pass to prevent "Email body" label-only and leaked reasoning artifacts
    fullText = sanitizeDraftContent(
      resolveEmailPlaceholders(aiData.content, resolvedContext.rep_profile?.full_name || null),
      channel
    );

    if (!fullText) {
      throw new Error("AI returned empty content after cleanup");
    }

    // Emit in chunks to keep progressive UX without relying on flaky SSE parsing
    const chunkSize = 50;
    for (let i = 0; i < fullText.length; i += chunkSize) {
      onToken(fullText.slice(i, i + chunkSize));
      await new Promise((r) => setTimeout(r, 0));
    }
  } catch (err) {
    console.error("[streamDraft] Streaming failed:", err);
  }

  const result: DraftPipelineResult = {
    ...partialResult,
    draft_text: fullText || null,
  };

  // Cache the result for 5 minutes (only if we got a good draft)
  if (fullText) {
    setCachedDraft(cacheKey, result);
  }

  console.log("[streamDraft] Complete:", { hasDraft: !!fullText, intent: finalIntent });
  return result;
}

// ============================================
// MAIN ORCHESTRATOR (non-streaming, kept for backward compat)
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
    (resolvedContext.lead as any).motion = motion_override;
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

  // Step 5: Build raw payload — merge lead's saved action_instructions with user-provided instructions
  const leadInstructions2 = (resolvedContext.lead as any).action_instructions as string | null;
  const mergedInstructions2 = mergeInstructions(instructions || null, leadInstructions2);
  const aiPayload = buildAIPayload(resolvedContext, finalIntent, mergedInstructions2);

  // Step 5b: Inject structured campaign resolver fields (matches automation-executor)
  const campaignFields2 = buildCampaignPayloadFields({
    action_key: inferActionKey(finalIntent, resolvedContext),
    motion: resolvedContext.motion || (resolvedContext.lead as any).motion || "outbound_prospecting",
    channel: channel === "linkedin" ? "email" : channel,
    outbound_tone: (resolvedContext.lead as any).outbound_tone || "direct",
    action_instructions: leadInstructions2,
    has_reply: !!resolvedContext.last_inbound_email,
    meeting_booked: resolvedContext.lead.has_future_meeting,
    calendar_link: resolvedContext.rep_profile?.calendar_link || null,
  });
  aiPayload.campaign_instruction = campaignFields2.campaign_instruction;
  aiPayload.campaign_meta = campaignFields2.campaign_meta;

  // Step 6: Call AI edge function
  let draftText: string | null = null;
  try {
    const { data, error } = await supabase.functions.invoke("ai_task", {
      body: { task: finalIntent, payload: aiPayload },
    });

    if (error) {
      console.error("[generateDraft] AI task error:", error);
    } else if (data?.ok && data?.content) {
      draftText = sanitizeDraftContent(
        resolveEmailPlaceholders(
          data.content,
          resolvedContext.rep_profile?.full_name || null
        ),
        channel
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
