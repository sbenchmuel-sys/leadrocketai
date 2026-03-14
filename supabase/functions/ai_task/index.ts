import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================
// MESSAGE DIVERSITY CONTROL
// ============================================

const OPENING_TYPES = ["observation", "problem", "trigger_event", "compliment", "direct_offer", "question", "followup_reference", "breakup"] as const;
const CTA_TYPES = ["quick_question", "soft_offer", "meeting_request", "permission_based", "timing_check", "breakup_close"] as const;

// Tasks that produce outreach messages (diversity applies to these)
const OUTREACH_TASKS = new Set([
  "email_intro_fast", "email_intro_nurture", "pre_email_1_intro", "pre_email_2_followup",
  "pre_email_3_followup", "pre_email_4_breakup", "inbound_intro", "re_engagement_intro",
  "nurture_email_single", "post_meeting_followup_email", "reply_to_thread",
  "whatsapp_message", "linkedin_connect", "linkedin_followup",
]);

interface DiversityConstraints {
  avoid_opening_types: string[];
  avoid_angles: string[];
  avoid_cta_types: string[];
  preferred_angles: string[];
  preferred_cta_types: string[];
}

/** Fetch recent message log and build diversity constraints */
async function buildDiversityConstraints(
  adminClient: ReturnType<typeof createClient>,
  leadId: string,
  workspaceId: string | null,
  campaignId: string | null,
): Promise<DiversityConstraints> {
  const constraints: DiversityConstraints = {
    avoid_opening_types: [],
    avoid_angles: [],
    avoid_cta_types: [],
    preferred_angles: [],
    preferred_cta_types: [],
  };

  try {
    // Fetch recent messages for this lead (for sequential dedup)
    const { data: leadMessages } = await adminClient
      .from("message_generation_log")
      .select("opening_type, primary_angle, cta_type, sequence_step, channel")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(8);

    if (leadMessages && leadMessages.length > 0) {
      // Rule: don't reuse same opening_type as the last message
      const lastOpening = leadMessages[0].opening_type;
      if (lastOpening) constraints.avoid_opening_types.push(lastOpening);

      // Rule: don't reuse same cta_type more than 2x in a row
      const recentCtas = leadMessages.slice(0, 3).map((m: any) => m.cta_type);
      const ctaCounts: Record<string, number> = {};
      for (const c of recentCtas) { if (c) ctaCounts[c] = (ctaCounts[c] || 0) + 1; }
      for (const [cta, count] of Object.entries(ctaCounts)) {
        if (count >= 2) constraints.avoid_cta_types.push(cta);
      }

      // Rule: avoid the last 2 primary_angles for this lead
      const recentAngles = leadMessages.slice(0, 2).map((m: any) => m.primary_angle).filter(Boolean);
      constraints.avoid_angles.push(...recentAngles);
    }

    // Fetch recent workspace-level messages for cross-lead diversity
    if (workspaceId) {
      let wsQuery = adminClient
        .from("message_generation_log")
        .select("primary_angle, opening_type, cta_type")
        .eq("workspace_id", workspaceId)
        .neq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (campaignId) {
        wsQuery = wsQuery.eq("campaign_id", campaignId);
      }

      const { data: wsMessages } = await wsQuery;

      if (wsMessages && wsMessages.length > 0) {
        // Rule: don't reuse same primary_angle > 3 times in last 20 similar messages
        const angleCounts: Record<string, number> = {};
        for (const m of wsMessages) {
          if (m.primary_angle) angleCounts[m.primary_angle] = (angleCounts[m.primary_angle] || 0) + 1;
        }
        for (const [angle, count] of Object.entries(angleCounts)) {
          if (count >= 3 && !constraints.avoid_angles.includes(angle)) {
            constraints.avoid_angles.push(angle);
          }
        }

        // Suggest underused CTAs and openings as preferred
        const usedOpenings = new Set(wsMessages.map((m: any) => m.opening_type).filter(Boolean));
        const usedCtas = new Set(wsMessages.map((m: any) => m.cta_type).filter(Boolean));
        for (const ot of OPENING_TYPES) {
          if (!usedOpenings.has(ot) && !constraints.avoid_opening_types.includes(ot)) {
            constraints.preferred_angles.push(ot); // suggest underused openings
          }
        }
        for (const ct of CTA_TYPES) {
          if (!usedCtas.has(ct) && !constraints.avoid_cta_types.includes(ct)) {
            constraints.preferred_cta_types.push(ct);
          }
        }
      }
    }

    console.log(`[ai_task] Diversity constraints: avoid_openings=[${constraints.avoid_opening_types}], avoid_angles=[${constraints.avoid_angles.slice(0,3)}], avoid_ctas=[${constraints.avoid_cta_types}]`);
  } catch (err) {
    console.error("[ai_task] Diversity constraint build failed:", err);
  }

  return constraints;
}

/** Format diversity constraints as a prompt injection block */
function formatDiversityBlock(constraints: DiversityConstraints): string {
  const parts: string[] = [];
  parts.push("=== MESSAGE DIVERSITY CONSTRAINTS ===");
  parts.push("To ensure fresh, varied outreach, follow these constraints:");

  if (constraints.avoid_opening_types.length > 0) {
    parts.push(`- DO NOT use these opening styles (recently used): ${constraints.avoid_opening_types.join(", ")}`);
  }
  if (constraints.avoid_angles.length > 0) {
    parts.push(`- DO NOT use these angles/themes (overused): ${constraints.avoid_angles.join(", ")}`);
  }
  if (constraints.avoid_cta_types.length > 0) {
    parts.push(`- DO NOT use these CTA types (recently used): ${constraints.avoid_cta_types.join(", ")}`);
  }
  if (constraints.preferred_cta_types.length > 0) {
    parts.push(`- PREFER one of these fresh CTA styles: ${constraints.preferred_cta_types.slice(0, 3).join(", ")}`);
  }

  parts.push("- Maintain brand voice consistency while varying approach");
  parts.push("- Quality and relevance always take priority over forced variation");

  return parts.join("\n");
}

/** Classification prompt for post-generation analysis */
const CLASSIFY_MESSAGE_PROMPT = `Classify this sales message. Return JSON ONLY:
{
  "opening_type": "observation|problem|trigger_event|compliment|direct_offer|question|followup_reference|breakup",
  "primary_angle": "short description of main value angle used (max 5 words)",
  "secondary_angle": "optional secondary angle or null",
  "cta_type": "quick_question|soft_offer|meeting_request|permission_based|timing_check|breakup_close",
  "tone": "professional|casual|urgent|empathetic|direct|consultative"
}

Message:
`;

/** Simple text similarity (Jaccard on word bigrams) */
function textSimilarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const words = s.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
    const bg = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) bg.add(`${words[i]} ${words[i+1]}`);
    return bg;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const bg of setA) { if (setB.has(bg)) intersection++; }
  return intersection / (setA.size + setB.size - intersection);
}

// Task-aware KB retrieval config: maps AI tasks → required content_types
// Retrieval returns max 1 chunk per content_type, max 4 total chunks
const TASK_KB_CONFIG: Record<string, string[]> = {
  // Outbound first touch / intros
  email_intro_fast:                   ["messaging", "knowledge", "industry"],
  email_intro_nurture:                ["messaging", "knowledge", "industry"],
  pre_email_1_intro:                  ["messaging", "knowledge", "industry"],
  inbound_intro:                      ["messaging", "knowledge", "industry"],
  re_engagement_intro:                ["messaging", "knowledge", "industry"],
  // Follow-ups
  followup_sequence_4:                ["messaging", "knowledge"],
  linkedin_followup:                  ["messaging", "knowledge"],
  // Reply handling
  reply_to_thread:                    ["knowledge", "objection", "messaging"],
  answer_questions:                   ["knowledge", "objection", "messaging"],
  // Meeting
  post_meeting_recap:                 ["knowledge", "discovery", "strategy"],
  post_meeting_followup_personalized: ["knowledge", "discovery", "strategy"],
  post_meeting_followup_email:        ["knowledge", "discovery"],
  // Nurture
  nurture_sequence:                   ["messaging", "industry"],
  nurture_email_single:               ["messaging", "industry"],
  // Analysis
  extract_milestones_risks:           ["strategy", "signal"],
  extract_deal_factors:               ["strategy", "signal"],
  recommend_next_steps:               ["strategy", "signal", "knowledge"],
  lead_deep_analysis:                 ["strategy", "signal", "industry"],
};

// Derive flat list for backward-compatible "should we search KB?" check
const KNOWLEDGE_SEARCH_TASKS = Object.keys(TASK_KB_CONFIG);

/** Max chunks returned per retrieval call */
const MAX_KB_CHUNKS = 4;

// Task categories for KB char limits
const ANALYSIS_TASKS = new Set([
  "post_meeting_recap", "post_meeting_followup_personalized", "post_meeting_followup_email",
  "extract_milestones_risks", "extract_deal_factors", "recommend_next_steps", "lead_deep_analysis",
]);
const KB_CHAR_LIMIT_OUTBOUND = 1200;
const KB_CHAR_LIMIT_ANALYSIS = 2400;

function getKbCharLimit(task: string): number {
  return ANALYSIS_TASKS.has(task) ? KB_CHAR_LIMIT_ANALYSIS : KB_CHAR_LIMIT_OUTBOUND;
}

/** Structured KB result grouped by content_type */
interface KBChunksGrouped {
  [contentType: string]: string;
}

// Generate a query embedding via OpenAI
async function generateQueryEmbedding(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text.slice(0, 8000), // text-embedding-3-small context limit
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[ai_task] Embedding API error (${response.status}):`, errText.slice(0, 200));
      return null;
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (err) {
    console.error("[ai_task] Failed to generate query embedding:", err);
    return null;
  }
}

// ============================================
// CHANNEL MESSAGING FRAMEWORK ROUTER
// ============================================

const CHANNEL_FRAMEWORKS: Record<string, string> = {
  email: `=== CHANNEL FRAMEWORK: EMAIL ===
Structure (follow this order):
1. Personalized observation — reference something specific about the lead or company
2. Business problem — articulate a clear pain point or challenge they likely face
3. Value proposition — one concise outcome or benefit (not a feature list)
4. Soft call to action — a low-friction question or next step

Constraints:
- 90–150 words
- Professional, structured tone
- Short paragraphs (1–3 sentences each)
- One CTA only
- No attachments in first email
- No calendar links unless explicitly provided`,

  sms: `=== CHANNEL FRAMEWORK: SMS ===
Structure (follow this order):
1. Curiosity hook — one compelling statement that creates intrigue
2. Quick question — a single low-friction question as CTA

Constraints:
- MAXIMUM 160 characters total (this is a hard limit)
- One sentence only
- Direct, concise tone
- No greeting beyond first name
- No sign-off or signature
- No links unless explicitly provided
- No emojis unless natural to the context`,

  whatsapp: `=== CHANNEL FRAMEWORK: WHATSAPP ===
Structure (follow this order):
1. Friendly opener — casual greeting with first name
2. Short context — 1–2 sentences explaining why you're reaching out
3. Question — a conversational question to invite a reply

Constraints:
- 1–3 short paragraphs maximum
- Casual, conversational tone (like texting a colleague)
- No formal sign-offs (no "Best regards", no signature blocks)
- Maximum 60 words
- One emoji max, only if natural
- No subject line
- No bracketed placeholders`,

  voice: `=== CHANNEL FRAMEWORK: VOICE ===
Structure (follow this order):
1. Reason for call — why you're calling in one sentence
2. Credibility context — brief mention of relevant experience, client, or insight
3. Discovery question — an open-ended question to start a conversation

Constraints:
- Use natural spoken language (not written/formal prose)
- Format as a short talk track with bullet points or brief sentences
- 3–5 bullet points maximum
- Each bullet should be speakable in under 10 seconds
- No jargon, no marketing language
- Include a suggested objection response if appropriate`,
};

// ============================================
// SEQUENCE-AWARE MESSAGING FRAMEWORKS
// ============================================

type SequenceStepFramework = { structure: string; goal: string; constraints: string };

const EMAIL_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: {
    structure: `1. Personalized observation — reference something specific about the lead or company
2. Quick context — one sentence on why you're reaching out
3. Question — a curiosity-driven question to invite a reply`,
    goal: "Spark curiosity and earn a reply",
    constraints: "Maximum 120 words. One CTA only. No attachments. No calendar links.",
  },
  2: {
    structure: `1. Industry insight — share a relevant trend or data point
2. Business problem — connect the insight to a likely challenge they face
3. Question — ask if they're experiencing this or exploring solutions`,
    goal: "Create problem awareness",
    constraints: "90–150 words. Reference a specific insight. One CTA only.",
  },
  3: {
    structure: `1. Proof or example — mention a relevant result, case study, or client outcome
2. Value proposition — tie the proof to a clear benefit for their situation
3. Soft CTA — suggest a next step without pressure`,
    goal: "Build credibility and demonstrate value",
    constraints: "90–150 words. One concrete proof point. One soft CTA.",
  },
  4: {
    structure: `1. Polite close — acknowledge you've reached out multiple times
2. Low pressure message — no guilt, no urgency tricks
3. Optional reconnect — leave the door open for future contact`,
    goal: "Respectful breakup that preserves the relationship",
    constraints: "60–100 words. No guilt language. No fake urgency. Warm and professional.",
  },
};

const SMS_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: {
    structure: "Curiosity question — one compelling question that creates intrigue",
    goal: "Spark curiosity",
    constraints: "MAXIMUM 160 characters. One sentence. Direct tone. No greeting beyond first name.",
  },
  2: {
    structure: "Problem question — ask about a specific pain point relevant to their role",
    goal: "Surface a problem",
    constraints: "MAXIMUM 160 characters. One sentence. No sign-off.",
  },
  3: {
    structure: "Short insight — share one concise data point or outcome",
    goal: "Provide value in minimal space",
    constraints: "MAXIMUM 160 characters. One sentence. Include a number or metric if possible.",
  },
  4: {
    structure: "Soft close — respectful final nudge or permission to close the loop",
    goal: "Breakup without pressure",
    constraints: "MAXIMUM 160 characters. No guilt. Warm tone.",
  },
};

const WHATSAPP_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: {
    structure: `1. Friendly opener — casual greeting with first name
2. Question — a conversational question to invite a reply`,
    goal: "Start a conversation naturally",
    constraints: "Maximum 60 words. Casual tone. One emoji max. No sign-off.",
  },
  2: {
    structure: `1. Short insight — one relevant trend or observation
2. Question — ask if this resonates with their situation`,
    goal: "Share value and keep the conversation going",
    constraints: "Maximum 60 words. Conversational. No formal language.",
  },
  3: {
    structure: `1. Proof — mention a relevant result or example briefly
2. Question — ask if they'd like to learn more`,
    goal: "Build credibility through a real example",
    constraints: "Maximum 60 words. Keep it light. No marketing speak.",
  },
  4: {
    structure: `1. Soft close — friendly message acknowledging the outreach
2. Open door — leave room for future contact`,
    goal: "Respectful close that preserves the relationship",
    constraints: "Maximum 50 words. Warm. No pressure.",
  },
};

const VOICE_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: {
    structure: `1. Reason for call — one sentence on why you're calling
2. Discovery question — an open-ended question to start a conversation`,
    goal: "Earn 30 more seconds of attention",
    constraints: "3–4 bullet points. Natural spoken language. Under 10 seconds per bullet.",
  },
  2: {
    structure: `1. Problem framing — articulate a challenge relevant to their role
2. Bridge question — ask how they're currently handling it`,
    goal: "Surface a pain point through conversation",
    constraints: "3–4 bullet points. No jargon. Conversational phrasing.",
  },
  3: {
    structure: `1. Proof — mention a relevant client result or outcome
2. Value bridge — connect the proof to their likely situation
3. Next step question — ask if it's worth exploring`,
    goal: "Demonstrate credibility and propose next step",
    constraints: "4–5 bullet points. Include one specific metric or name if available.",
  },
  4: {
    structure: `1. Permission close — acknowledge multiple attempts respectfully
2. Final question — ask if timing is wrong or if there's someone better to speak with`,
    goal: "Respectful close or redirect",
    constraints: "3 bullet points max. No guilt. Professional warmth.",
  },
};

const SEQUENCE_FRAMEWORKS: Record<string, Record<number, SequenceStepFramework>> = {
  email: EMAIL_SEQUENCE,
  sms: SMS_SEQUENCE,
  whatsapp: WHATSAPP_SEQUENCE,
  voice: VOICE_SEQUENCE,
};

// Map task_type to implicit sequence step
const TASK_TO_SEQUENCE_STEP: Record<string, number> = {
  pre_email_1_intro: 1,
  email_intro_fast: 1,
  email_intro_nurture: 1,
  inbound_intro: 1,
  re_engagement_intro: 1,
  pre_email_2_followup: 2,
  pre_email_3_followup: 3,
  pre_email_4_breakup: 4,
};

/**
 * Resolve sequence step from explicit payload or task_type mapping.
 */
function resolveSequenceStep(task: string, payloadStep?: number | string): number | null {
  if (payloadStep != null) {
    const n = Number(payloadStep);
    if (n >= 1 && n <= 4) return n;
  }
  return TASK_TO_SEQUENCE_STEP[task] ?? null;
}

/**
 * Get sequence-aware framework block. When a sequence step is known,
 * this overrides the generic channel framework with step-specific structure.
 */
function getSequenceFramework(channel: string, step: number): string {
  const channelSeq = SEQUENCE_FRAMEWORKS[channel];
  if (!channelSeq) return "";
  const fw = channelSeq[step];
  if (!fw) return "";

  return `=== SEQUENCE STEP ${step} FRAMEWORK (${channel.toUpperCase()}) ===
Goal: ${fw.goal}

Structure (follow this order):
${fw.structure}

Constraints:
${fw.constraints}`;
}

const CHANNEL_FRAMEWORK_EXEMPT_TASKS = new Set([
  "intent_router", "extract_milestones_risks", "extract_deal_factors",
  "recommend_next_steps", "lead_deep_analysis", "analyze_outgoing_email",
  "match_email_to_milestones", "dedupe_milestones", "whatsapp_classify_intent",
  "followup_sequence_4", "post_meeting_recap", "nurture_sequence",
]);

function resolveChannel(task: string, payloadChannel?: string): string {
  if (task.startsWith("whatsapp_")) return "whatsapp";
  if (task.startsWith("linkedin_")) return "email";
  if (task === "shorten_draft") return payloadChannel || "email";
  return payloadChannel || "email";
}

function getChannelFramework(task: string, channel: string): string {
  if (CHANNEL_FRAMEWORK_EXEMPT_TASKS.has(task)) return "";
  return CHANNEL_FRAMEWORKS[channel] || "";
}

// Semantic search — returns structured chunks grouped by content_type
async function getSemanticKnowledgeChunks(
  queryText: string,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  leadId?: string,
  contentTypes?: string[]
): Promise<KBChunksGrouped | null> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    console.log("[ai_task] No OPENAI_API_KEY — falling back to text search");
    return null;
  }

  const queryEmbedding = await generateQueryEmbedding(queryText, openaiKey);
  if (!queryEmbedding) {
    console.warn("[ai_task] Failed to generate query embedding — falling back to text search");
    return null;
  }

  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const fetchCount = contentTypes ? Math.max(contentTypes.length * 3, 10) : MAX_KB_CHUNKS;

    const { data: matches, error } = await supabaseAdmin.rpc("match_knowledge_chunks_v2", {
      query_embedding: JSON.stringify(queryEmbedding),
      p_owner_user_id: userId,
      match_threshold: 0.4,
      match_count: fetchCount,
      filter_customer_facing: true,
      filter_lead_id: leadId || null,
      filter_content_types: contentTypes || null,
    });

    if (error) {
      console.error("[ai_task] Semantic search failed:", error);
      return null;
    }

    if (!matches || matches.length === 0) {
      console.log("[ai_task] No semantic matches found");
      return null;
    }

    // Deduplicate: 1 chunk per content_type, max MAX_KB_CHUNKS
    const grouped: KBChunksGrouped = {};
    let count = 0;
    for (const m of matches) {
      const ct = m.content_type || "knowledge";
      if (grouped[ct]) continue;
      const header = m.title ? `[${m.title}] ` : "";
      grouped[ct] = `${header}${m.content}`;
      count++;
      if (count >= MAX_KB_CHUNKS) break;
    }

    console.log(`[ai_task] Semantic: ${matches.length} raw → ${count} grouped (${Object.keys(grouped).join(",")}), top sim: ${matches[0]?.similarity?.toFixed(3)}`);
    return grouped;
  } catch (err) {
    console.error("[ai_task] Error in semantic search:", err);
    return null;
  }
}

// Fallback: text-based ILIKE search — returns structured chunks grouped by content_type
async function getTextBasedKnowledgeChunks(
  queryText: string,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  leadId?: string
): Promise<KBChunksGrouped | null> {
  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    
    let query = supabaseAdmin
      .from("kb_chunks")
      .select("id, title, content, source, content_type")
      .eq("owner_user_id", userId)
      .eq("allowed_customer_facing", true)
      .eq("processing_status", "completed")
      .limit(10);
    
    if (leadId) {
      query = query.or(`lead_id.eq.${leadId},lead_id.is.null`);
    }
    
    const keyTerms = queryText
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 4)
      .slice(0, 5);
    
    if (keyTerms.length > 0) {
      const contentFilters = keyTerms.map(term => `content.ilike.%${term}%`).join(',');
      query = query.or(contentFilters);
    }
    
    const { data: matches, error } = await query;

    if (error) {
      console.error("[ai_task] Text search failed:", error);
      return null;
    }

    if (!matches || matches.length === 0) {
      console.log("[ai_task] No text matches found");
      return null;
    }

    // Group by content_type, 1 per type, max MAX_KB_CHUNKS
    const grouped: KBChunksGrouped = {};
    let count = 0;
    for (const m of matches) {
      const ct = (m as any).content_type || "knowledge";
      if (grouped[ct]) continue;
      const header = m.title ? `[${m.title}] ` : "";
      grouped[ct] = `${header}${m.content}`;
      count++;
      if (count >= MAX_KB_CHUNKS) break;
    }

    console.log(`[ai_task] Text fallback: ${matches.length} raw → ${count} grouped (${Object.keys(grouped).join(",")})`);
    return grouped;
  } catch (err) {
    console.error("[ai_task] Error in text search:", err);
    return null;
  }
}

/** Format grouped KB chunks into a structured context block with char limit */
function formatKBContext(grouped: KBChunksGrouped, charLimit: number): string {
  const parts: string[] = [];
  let totalLen = 0;

  for (const [contentType, content] of Object.entries(grouped)) {
    const label = contentType.toUpperCase();
    const entry = `[${label}]\n${content}`;
    if (totalLen + entry.length > charLimit) {
      // Truncate this entry to fit
      const remaining = charLimit - totalLen;
      if (remaining > 50) {
        parts.push(`[${label}]\n${content.slice(0, remaining - label.length - 4)}…`);
      }
      break;
    }
    parts.push(entry);
    totalLen += entry.length;
  }

  return parts.join("\n\n---\n\n");
}

// Combined retrieval: semantic first, ILIKE fallback
// Returns structured KB context string with task-aware char limits
async function getKnowledgeContext(
  queryText: string,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  leadId?: string,
  task?: string
): Promise<{ formatted: string; grouped: KBChunksGrouped }> {
  const contentTypes = task ? TASK_KB_CONFIG[task] || undefined : undefined;
  const charLimit = task ? getKbCharLimit(task) : KB_CHAR_LIMIT_OUTBOUND;

  if (contentTypes) {
    console.log(`[ai_task] Task "${task}" → KB types: [${contentTypes.join(", ")}], limit: ${charLimit} chars`);
  }

  // Try semantic search first
  let grouped = await getSemanticKnowledgeChunks(queryText, supabaseUrl, supabaseServiceKey, userId, leadId, contentTypes);

  // Fallback to text-based search
  if (!grouped) {
    console.log("[ai_task] Falling back to text-based KB search");
    grouped = await getTextBasedKnowledgeChunks(queryText, supabaseUrl, supabaseServiceKey, userId, leadId);
  }

  if (!grouped || Object.keys(grouped).length === 0) {
    return { formatted: "", grouped: {} };
  }

  const formatted = formatKBContext(grouped, charLimit);
  return { formatted, grouped };
}

// Dynamic CORS based on allowed origins
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  
  // In development, allow localhost origins; in production, allow Lovable project domains
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isCustomDomain = origin === "https://drivepilot.app" || origin === "https://www.drivepilot.app";
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || isCustomDomain || allowedOrigins.includes("*");
  
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// System prompt
const SYSTEM_GLOBAL_PROMPT = `You are Lead Rocket AI, an AI-powered sales execution assistant.

Primary Goal:
Generate high-quality sales messages that maximize reply probability while maintaining professionalism and alignment with the selected industry playbook.

HARD RULES
1) Nothing is ever auto-sent. You only create drafts and suggested actions.
2) Never invent facts. If unknown, ask for missing info or propose a safe next step.
3) No medical advice. No diagnosis/treatment claims. Do not claim clinical performance unless explicitly present in Knowledge Context.
4) No legal advice. For privacy/security questions, provide general best practices and point to official/security documentation if provided.
5) Customer-safe: do not share internal-only pricing/roadmap/confidential notes unless Knowledge Context explicitly marks it as allowed_customer_facing=true.
6) Be concise and structured: short paragraphs, 1 clear CTA per email, avoid jargon and marketing hype.
7) Personalize using lead/company/context. If missing, keep it generic and ask 1 clarifying question only when necessary.
8) If a task requires JSON, output JSON ONLY (no extra text). If output is an email body, output only the body text (no subject unless asked).
9) If you include "evidence", keep evidence snippets <= 200 characters.
10) Never fabricate claims. Respect compliance and disallowed topics.
11) Optimize for clarity and momentum.

OBJECTION HANDLING
When an objection is detected in the conversation:
1) Acknowledge briefly — show you understand their concern.
2) Provide focused reframing or relevant documentation (max 3-5 sentences).
3) Offer one low-friction next step.
Do not argue. Do not over-explain. Do not sound defensive.

INPUTS YOU MAY RECEIVE
- Lead context (name, company, motion, notes, meeting link)
- Interaction snippets (emails, meeting summaries)
- Optional Knowledge Context (approved snippets, product decks, FAQs)
- Playbook Context (industry-specific tone, objections, signals)
- Motion blocks (outbound, inbound, nurture, closing, post-meeting)

YOUR GOAL
Maximize reply probability, surface risks early, and guide next steps while staying compliant and professional.`;

// Cold outreach style blocks — injected for outbound first-touch emails
const COLD_OUTREACH_STYLE_BLOCK = `
=== COLD OUTREACH STYLE: HIGH REPLY RATE MODE ===
Structure:
- 3-6 sentences max
- 1 idea per paragraph
- No large blocks of text
- No attachments in first email
Opening:
- Personalized observation OR relevant trigger OR specific problem hypothesis
Core:
- One clear outcome
- One short proof point (metric, client, example)
- No feature list
CTA:
- Micro-commitment only
- Yes/No question OR "Worth a quick look?" OR "Open to a short conversation?"
Avoid:
- Long intros, company history, multiple CTAs
- Calendar links in first email
- Generic "just checking in"
Psychology:
- Reduce pressure, make reply easy, signal relevance, leave room for correction
`;

const COLD_OUTREACH_SAAS_BLOCK = `
=== COLD OUTREACH STYLE: B2B SAAS HIGH REPLY ===
Length: Under 120 words.
Opening:
- Reference something specific about their company
- OR hypothesize a clear bottleneck
- Example: "Noticed you're hiring for X…" / "Saw you recently launched Y…"
Core:
- Tie product to one measurable outcome
- Use one concrete metric
- Avoid listing features
CTA:
- "Is this something you're exploring?"
- "Would a 15-min chat make sense?"
- "Worth sharing a quick breakdown?"
Avoid:
- Overly polished marketing language
- Buzzwords like "Revolutionary" / "Best-in-class"
Psychological triggers:
- Relevance, specificity, low friction, curiosity gap
`;

const COLD_OUTREACH_MEDICAL_BLOCK = `
=== COLD OUTREACH STYLE: MEDICAL DEVICE HIGH REPLY ===
Length: Under 130 words.
Opening:
- Professional introduction
- Clear context (why reaching out)
Core:
- One clinical or operational benefit
- Avoid exaggerated claims
- Reference use case
CTA:
- "Would it make sense to share more details?"
- "Open to a brief discussion?"
- "Who would be best to speak with?"
Avoid:
- Urgency pressure
- Sales-heavy tone
- Aggressive follow-ups
Psychological triggers:
- Professional credibility, safety, process alignment
`;

// Psychological reply patterns — rotated into follow-up and breakup emails
const REPLY_PATTERNS_BLOCK = `
=== REPLY OPTIMIZATION PATTERNS ===
Rotate one of these CTA patterns per email to maximize reply probability:
Permission-Based: "If this isn't relevant, feel free to say so — I'll close the loop."
Soft Assumption: "If this is already handled internally, happy to step aside."
Binary Micro-CTA: "Would you say this is: A) Relevant now B) Worth revisiting later C) Not a priority"
Curiosity Close: "Worth sharing how we've approached this with similar teams?"
Rules:
- Use ONE pattern per email, do not stack
- Match pattern to deal stage
- Keep the CTA as the final sentence
`;

// Playbook-specific breakup closers
const BREAKUP_CLOSERS: Record<string, string> = {
  b2b_saas: `Breakup style: "I haven't heard back, so I'll assume this isn't a priority right now. If I'm wrong, happy to reconnect. Either way — appreciate the time."`,
  general_sales: `Breakup style: "Seems like timing may not be right. Should I close the loop for now?"`,
};

const COLD_OUTREACH_GENERAL_BLOCK = `
=== COLD OUTREACH STYLE: GENERAL B2B HIGH REPLY ===
Length: Under 90 words. Target 65 words.
Opening:
- Reference something specific about their role, company, or industry
- OR ask a direct question about a likely challenge they face
- NEVER start with abstract/philosophical questions
Core:
- One sentence connecting your outreach to a clear business outcome
- No feature lists, no product pitches
CTA:
- One simple question that's easy to reply to
- "Is this something you're dealing with?"
- "Worth a quick chat?"
Avoid:
- Abstract "What if" questions
- Vague value propositions
- Marketing language
- Long intros or company history
Psychological triggers:
- Specificity, relevance, low friction, conversational tone
`;

// Map playbook IDs to specialized outreach blocks
const PLAYBOOK_OUTREACH_BLOCKS: Record<string, string> = {
  b2b_saas: COLD_OUTREACH_SAAS_BLOCK,
  medical_device_rep: COLD_OUTREACH_MEDICAL_BLOCK,
  general_sales: COLD_OUTREACH_GENERAL_BLOCK,
};

function getColdOutreachBlock(playbookId: string): string {
  return PLAYBOOK_OUTREACH_BLOCKS[playbookId] || COLD_OUTREACH_STYLE_BLOCK;
}

// ============================================
// EMAIL FRAMEWORK ROUTER
// ============================================

type EmailFramework = "curiosity" | "observation" | "hypothesis" | "ultra_short";

const EMAIL_FRAMEWORK_BLOCKS: Record<EmailFramework, string> = {
  curiosity: `=== MESSAGE FRAMEWORK: CURIOSITY ===
Opening: Start with a SHORT question that creates genuine curiosity about their specific situation.
The question MUST reference their industry, role, or company directly — never be abstract or philosophical.
Do NOT answer the question yourself. Let them respond.
Do NOT use "What if..." constructions. Use direct, specific questions instead.
GOOD examples:
- "Are your printing teams still manually tracking reprint rates?"
- "How are you handling turnaround guarantees when order volume spikes?"
- "Curious — what's your biggest bottleneck during peak season?"
BAD examples (NEVER use these patterns):
- "What if the biggest growth lever for X isn't Y — it's Z?"
- "What if transforming existing operations was the key?"
- Any philosophical/abstract question that could apply to any industry`,

  observation: `=== MESSAGE FRAMEWORK: OBSERVATION ===
Opening: Reference a REAL signal or activity about their company.
The observation must come from the Sales Signals provided. Do NOT fabricate observations.
Connect the observation to a relevant question or insight.
Example pattern: "Noticed [specific signal]. Curious how that's affecting [related area]?"`,

  hypothesis: `=== MESSAGE FRAMEWORK: HYPOTHESIS ===
Opening: Propose a likely bottleneck or challenge they face based on their industry/role.
The hypothesis must be specific and testable — something they can confirm or deny.
Frame it as a question, not a statement.
Example pattern: "Most [role] at [industry type] companies tell us [specific bottleneck]. Is that true for [company]?"`,

  ultra_short: `=== MESSAGE FRAMEWORK: ULTRA-SHORT ===
Structure: 2-3 sentences MAXIMUM. No paragraphs. No greeting beyond first name.
Get to the point in one breath. One question only.
Example pattern: "Hi [name], [one sentence context]. [one question]?"`,
};

/** Select email framework based on available signals and context */
function selectEmailFramework(
  signals: { type: string; description: string }[],
  industry?: string,
  leadContext?: string,
): EmailFramework {
  if (signals && signals.length > 0) {
    const actionableTypes = ["hiring", "funding", "expansion", "product_launch", "new_partnership", "press_coverage"];
    if (signals.some(s => actionableTypes.includes(s.type))) return "observation";
  }
  if (industry || leadContext) {
    const ctx = `${industry || ""} ${leadContext || ""}`.toLowerCase();
    const painIndicators = ["manual", "spreadsheet", "legacy", "outdated", "inefficient", "scaling", "bottleneck", "turnover", "compliance"];
    if (painIndicators.some(p => ctx.includes(p))) return "hypothesis";
  }
  return "curiosity";
}

function getEmailFrameworkBlock(framework: EmailFramework): string {
  return EMAIL_FRAMEWORK_BLOCKS[framework] || EMAIL_FRAMEWORK_BLOCKS.curiosity;
}

// ============================================
// COLD EMAIL QUALITY SCORER
// ============================================

interface EmailQualityScore {
  curiosity: number;
  human_tone: number;
  spam_risk: number;
  reply_likelihood: number;
  summary: string;
}

const QUALITY_SCORER_PROMPT = `You are evaluating a cold outreach email for reply probability.

Score the email on these four dimensions (0-10 each):

1. Curiosity — Does the opening create curiosity or a question that invites response?
2. Human Tone — Does the message sound like a real human email rather than marketing copy?
3. Spam Risk — Does the message avoid spam triggers, buzzwords, or promotional tone? (10 = no spam risk)
4. Reply Likelihood — How likely is this email to receive a response?

Return JSON ONLY:
{
  "curiosity": <number 0-10>,
  "human_tone": <number 0-10>,
  "spam_risk": <number 0-10>,
  "reply_likelihood": <number 0-10>,
  "summary": "<one sentence explanation>"
}`;

const QUALITY_THRESHOLD = 24;

/** Outbound email tasks that should be quality-scored */
const QUALITY_SCORED_TASKS = new Set([
  "pre_email_1_intro", "pre_email_2_followup", "pre_email_3_followup", "pre_email_4_breakup",
  "email_intro_fast", "email_intro_nurture", "re_engagement_intro",
]);

// Centralized motion block builder
function buildMotionBlock({ motion, first_touch }: { motion: string; first_touch: boolean }): string {
  if (motion === "outbound_prospecting" && first_touch) {
    return `=== MOTION: OUTBOUND FIRST TOUCH ===
Objective:
Trigger a reply. Not to close. Not to explain fully.

CRITICAL: You MUST produce fewer than 90 words. Count every word carefully.
If in doubt, make it shorter. Under 75 words is ideal.

STRICT STRUCTURE RULES:
- ABSOLUTE Maximum 90 words. No exceptions.
- Maximum 5 short paragraphs.
- One idea only.
- One CTA only (a simple question, never a calendar link).
- No feature lists.
- No attachments.
- No calendar links.

Knowledge usage:
- Use only for positioning alignment.
- Do NOT include case studies or long explanations.`;
  }

  if (motion === "outbound_prospecting") {
    return `=== MOTION: OUTBOUND FOLLOW-UP ===
Objective:
Re-engage the prospect with a new angle or value point.

STRUCTURE RULES:
- Maximum 120 words.
- Reference previous outreach naturally.
- One new insight or angle per email.
- One CTA only.`;
  }

  if (motion === "inbound_response") {
    return `=== MOTION: INBOUND RESPONSE ===
Objective:
Convert interest into a scheduled conversation.

Structure:
- Mirror the lead's energy and brevity.
- Acknowledge their interest in ONE short sentence.
- Provide the next step (meeting link, calendar, or specific question).
- Do NOT re-pitch or explain the product — the lead already showed interest.
- Do NOT describe your company's technology or value proposition.

Length:
- If the lead's message is under 30 words: reply in 40-60 words max.
- Otherwise: up to 100 words max.
- NEVER exceed 100 words for inbound responses unless the lead is asking detailed questions that require KB context.`;
  }

  if (motion === "nurture") {
    return `=== MOTION: NURTURE ===
Objective:
Maintain relevance without pressure.

Structure:
- Short value insight.
- Soft CTA.
- No urgency.

Length:
- 60–120 words.`;
  }

  return "";
}

// Centralized style modifier builder
function buildStyleModifier({ motion, first_touch, outbound_style }: { motion: string; first_touch: boolean; outbound_style: string }): string {
  if (motion !== "outbound_prospecting" || !first_touch) {
    return "";
  }

  if (outbound_style === "high_reply") {
    return `=== OUTBOUND STYLE: HIGH REPLY ===
Opening Adjustment:
- Begin with a short disarming phrase (e.g., "Quick one —") OR start with a focused question.
- Prefer question-first framing.
- Keep opening under 2 short lines.
- Introduce mild tension around a likely pain point.

Do NOT:
- Increase total word count.
- Add humor unless clearly appropriate.
- Change compliance tone.
- Override motion structure rules.`;
  }

  return `=== OUTBOUND STYLE: STANDARD ===
Opening Adjustment:
- Professional, direct opening.
- State relevance clearly in the first sentence.
- No gimmicks.

Do NOT:
- Override motion structure rules.
- Increase total word count.`;
}

// Single-pass prompt assembler — enforces strict block order
function buildFinalUserPrompt({ motionBlock, styleModifier, playbookContext, taskPrompt }: {
  motionBlock: string;
  styleModifier: string;
  playbookContext: string;
  taskPrompt: string;
}): string {
  const parts: string[] = [];
  if (motionBlock) parts.push(motionBlock);
  if (styleModifier) parts.push(styleModifier);
  if (playbookContext) parts.push(playbookContext);
  parts.push(taskPrompt);
  return parts.join("\n\n");
}

// Task prompts
const PROMPTS: Record<string, string> = {
  intent_router: `You are classifying an inbound B2B email for a regulated enterprise sales process.

Return JSON ONLY in this exact schema:
{
  "intent_primary": "book_meeting|pricing|technical_sdk|security_privacy|legal_procurement|partnership|support|not_sure",
  "urgency": "high|medium|low",
  "reply_worthy": true,
  "suggested_motion": "outbound_prospecting|inbound_response|nurture|closing|post_meeting",
  "questions_extracted": ["..."],
  "tone": "positive|neutral|negative"
}

Rules:
- reply_worthy=true if the email requires a response from sales (questions, requests, objections, meeting scheduling).
- suggested_motion=inbound_response if urgency high OR explicit request for call/demo/pricing/procurement steps.
- Extract explicit questions verbatim into questions_extracted.
- If unclear, intent_primary="not_sure" and reply_worthy=true.

INPUT:
Lead Context:
{{LEAD_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}`,

  email_intro_fast: `ROLE
You are writing an intro email reply for a high-urgency regulated B2B lead.

GOAL
Respond clearly, create confidence, and book a meeting soon.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Sales Signals (recent intelligence):
{{SIGNALS}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 120–180 words
- 1 clear CTA (book a 30-min call)
- If they asked questions, answer briefly and offer to cover deeper on call
- Do NOT mention anything not in Knowledge Context
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best," followed by the rep's first name extracted from the "Sender Name" field in Rep Context above
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Unknown Company], [Rep's first name], [Your Name], [Lead's implied need], [Meeting Link], etc.
- If the lead's company is missing or says "Unknown Company", simply omit company references rather than using placeholders
- MEETING LINK: CRITICAL - You MUST use the EXACT URL provided in "Meeting Link" above. Copy it verbatim. Do NOT invent, modify, or guess any meeting/calendar URLs. If Meeting Link is empty, ask them to reply with their availability instead. Do NOT mention timezones.

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  email_intro_nurture: `ROLE
You are writing a value-led intro email reply for a regulated B2B lead.

GOAL
Be helpful, provide 1–2 value points, share 1 resource, invite a call without pressure.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Optional resource to mention:
{{RESOURCE_LINK_OR_TITLE}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 140–220 words
- Helpful tone, credibility-building
- 1 soft CTA (offer a call / ask what's best next step)
- Use Knowledge Context only
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best," followed by the rep's first name extracted from the "Sender Name" field in Rep Context above
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Unknown Company], [Rep's first name], [Your Name], [Lead's implied need], [Meeting Link], etc.
- If the lead's company is missing or says "Unknown Company", simply omit company references rather than using placeholders
- MEETING LINK: CRITICAL - You MUST use the EXACT URL provided in "Meeting Link" above. Copy it verbatim. Do NOT invent, modify, or guess any meeting/calendar URLs. If Meeting Link is empty, ask them to reply with their availability instead. Do NOT mention timezones.

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  followup_sequence_4: `Generate a 4-email follow-up sequence for a regulated B2B prospect.
Use the motion context to determine tone and pacing.

IMPORTANT: Use the configured cadence timing provided below. This defines the days between each email in the sequence.
Configured cadence: {{CADENCE_DAYS}}

Return JSON ONLY in this schema:
{
  "motion": "{{MODE}}",
  "cadence_days": {{CADENCE_DAYS}},
  "emails": [
    {"draft_type":"fu1","subject":"...","body":"..."},
    {"draft_type":"fu2","subject":"...","body":"..."},
    {"draft_type":"fu3","subject":"...","body":"..."},
    {"draft_type":"fu4","subject":"...","body":"..."}
  ]
}

Rules:
- Each email must have ONE CTA
- Keep bodies short: 80–150 words
- Email 2 adds value (insight/resource)
- Email 3 adds urgency (light, not pushy)
- Email 4 is a polite breakup
- Never include medical claims or unapproved info
- If mentioning "I'll follow up in X days", use the appropriate value from the configured cadence

INPUT:
Mode: {{MODE}}
Lead Context: {{LEAD_CONTEXT}}
What has been sent so far (optional): {{SENT_SO_FAR}}
Knowledge Context: {{KNOWLEDGE_CONTEXT}}
Meeting link (optional): {{MEETING_LINK}}`,

  post_meeting_recap: `You are given a meeting summary (or notes). Produce:
1) an internal recap
2) a customer follow-up email draft

Return JSON ONLY:
{
  "internal_recap_bullets": ["..."],
  "milestones_from_meeting": [{"description":"...","status":"completed|pending","date":null}],
  "open_questions": ["..."],
  "customer_email": {"subject":"...","body":"..."}
}

Rules:
- Internal recap can be direct
- Customer email must be polished, positive, accurate
- Include clear next steps (who does what)
- One CTA (e.g. confirm next meeting / share doc)
- Use Knowledge Context if it helps answer questions raised

INPUT:
Mode: {{MODE}}
Lead Context: {{LEAD_CONTEXT}}
Meeting Summary: {{MEETING_SUMMARY}}
Knowledge Context: {{KNOWLEDGE_CONTEXT}}
Meeting link (optional): {{MEETING_LINK}}`,

  answer_questions: `ROLE
You are rewriting a sales email draft to answer prospect questions using knowledge base information.

GOAL
Write a complete, ready-to-send email that answers the prospect's question(s), grounded ONLY in the Knowledge Context.
If knowledge is insufficient, say what you can, then propose a call or offer to share the right document.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Current Draft:
{{DRAFT_TEXT}}

Questions to Answer:
{{QUESTIONS_LIST}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Meeting link (optional):
{{MEETING_LINK}}

CONSTRAINTS
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context (e.g., if lead name is "Mukul Gupta", write "Hi Mukul,")
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY (extracted from Sender Name in Rep Context) on the next line with NO blank line between (e.g., if Sender Name is "Sarah Johnson", write "Best regards,\nSarah")
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Rep's First Name], [Your Name], etc.
- MEETING LINK EMBEDDING: CRITICAL - If a "Calendar Link" appears in Rep Context above, you MUST embed the complete URL directly in a sentence (e.g., "You can book a time here: https://calendly.com/shai-benchmuel/30min"). Copy the exact URL. Do NOT use "[Meeting Link]" placeholder. If no Calendar Link provided, suggest they reply with availability.
- DURATION: Do NOT mention specific meeting durations like "15-minute" or "30-minute" unless you can confidently extract it from the Meeting Link URL. Use generic terms like "call" or "meeting" instead.
- The email must be complete and ready to send
- No subject line - only the email body
- No signature block - just the closing and first name

OUTPUT
Return the complete EMAIL BODY ONLY with real names (not placeholders).`,

  extract_milestones_risks: `Extract deal milestones and risks from the provided interactions and any meeting summaries in the knowledge context.
Return JSON ONLY:
{
  "milestones": [
    {"description":"...","status":"completed|pending","date":"YYYY-MM-DD|null","evidence":"short quote <=200 chars"}
  ],
  "risks": [
    {"issue":"...","level":"low|medium|high","evidence":"short quote <=200 chars"}
  ]
}

Rules:
- Only include items supported by evidence from the interactions or knowledge context
- Evidence must be a short snippet from the interactions or knowledge (<=200 chars)
- If no items, return empty arrays
- Prioritize information from meeting summaries in knowledge context

Lead Context:
{{LEAD_CONTEXT}}

Interactions (most recent first):
{{INTERACTIONS_TEXT}}

Knowledge Context (includes meeting summaries):
{{KNOWLEDGE_CONTEXT}}`,

  extract_deal_factors: `Return JSON ONLY:
{
  "engagement_level":"high|medium|low",
  "reply_latency":"fast|medium|slow|unknown",
  "decision_maker_involved": true|false|"unknown",
  "identified_champion": "none|unknown|role_or_name",
  "budget_status":"known|unknown|blocked|in_review",
  "timeline":"urgent|normal|long|unknown",
  "procurement_stage":"none|security|legal|procurement|contract_redlines|unknown",
  "overall_outlook":"positive|neutral|negative",
  "reasoning":"1-3 sentences grounded in evidence"
}

Rules:
- Use provided interactions, meeting notes, and knowledge context
- If uncertain, use unknown
- Keep reasoning short and fact-based
- Prioritize information from meeting summaries in knowledge context

Lead Context:
{{LEAD_CONTEXT}}

Interactions:
{{INTERACTIONS_TEXT}}

Knowledge Context (includes meeting summaries):
{{KNOWLEDGE_CONTEXT}}`,

  recommend_next_steps: `Return JSON ONLY:
{
  "recommendations": [
    {"title":"...", "why":"...", "action":"email|linkedin|meeting|internal", "priority":"P0|P1|P2"}
  ],
  "best_next_step": {"title":"...", "why":"...", "action":"email|linkedin|meeting|internal"}
}

Rules:
- Must be specific, actionable, tied to what's missing
- Keep "why" to 1–2 sentences
- Prefer P0 actions that unblock the next gate (security, decision maker, meeting, etc.)
- Consider meeting summaries and lead-specific knowledge context

Lead Context:
{{LEAD_CONTEXT}}

Current milestones/risks:
{{MILESTONES_RISKS_JSON}}

Deal factors:
{{DEAL_FACTORS_JSON}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}`,

  // --- STRATEGY 3: Batch Analysis (3-in-1) ---
  lead_deep_analysis: `Perform a comprehensive lead analysis combining milestones/risks extraction, deal factor assessment, and next step recommendations.

Return JSON ONLY in this exact schema:
{
  "milestones": [
    {"description":"...","status":"completed|pending","date":"YYYY-MM-DD|null","evidence":"short quote <=200 chars"}
  ],
  "risks": [
    {"issue":"...","level":"low|medium|high","evidence":"short quote <=200 chars"}
  ],
  "deal_factors": {
    "engagement_level":"high|medium|low",
    "reply_latency":"fast|medium|slow|unknown",
    "decision_maker_involved": true|false|"unknown",
    "identified_champion": "none|unknown|role_or_name",
    "budget_status":"known|unknown|blocked|in_review",
    "timeline":"urgent|normal|long|unknown",
    "procurement_stage":"none|security|legal|procurement|contract_redlines|unknown",
    "overall_outlook":"positive|neutral|negative",
    "reasoning":"1-3 sentences grounded in evidence"
  },
  "recommendations": [
    {"title":"...", "why":"...", "action":"email|linkedin|meeting|internal", "priority":"P0|P1|P2"}
  ],
  "best_next_step": {"title":"...", "why":"...", "action":"email|linkedin|meeting|internal"}
}

Rules:
- Only include milestones/risks supported by evidence from interactions or knowledge context
- Evidence must be <=200 chars
- If uncertain on deal factors, use "unknown"
- Recommendations must be specific and actionable
- Prefer P0 actions that unblock the next gate
- Keep all reasoning short and fact-based

Lead Context:
{{LEAD_CONTEXT}}

Sales Signals (recent intelligence):
{{SIGNALS}}

Interactions (most recent first):
{{INTERACTIONS_TEXT}}

Knowledge Context (includes meeting summaries):
{{KNOWLEDGE_CONTEXT}}`,

  linkedin_connect: `Write a LinkedIn connection note under 300 characters.
No selling. Mention a real reason to connect (context given).
Return TEXT ONLY.

Prospect: {{PROSPECT_NAME}}, {{TITLE}} at {{COMPANY}}
Context: {{CONTEXT}}`,

  linkedin_followup: `Write a short LinkedIn message (max 600 characters).
Professional, friendly, one question at the end.
No hard pitch. Offer a relevant insight.
Return TEXT ONLY.

Prospect: {{PROSPECT_NAME}}, {{TITLE}} at {{COMPANY}}
Context: {{CONTEXT}}
Knowledge Context (optional): {{KNOWLEDGE_CONTEXT}}`,

  // Inbound Intro — first-touch email for inbound leads
  inbound_intro: `ROLE
You are writing the first response email to an inbound lead who has expressed interest via a website form, referral, or inbound inquiry.

GOAL
Acknowledge their message, provide one relevant value point, and propose a clear next step. Convert interest into a conversation — NOT a cold pitch.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Lead's Initial Message:
{{LEAD_CARD_MESSAGE}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 100–150 words
- Warm, responsive tone — they came to YOU
- MUST acknowledge their specific message or interest area directly in the opening
- Provide ONE relevant value point from Knowledge Context (if available)
- End with a clear next step: propose a meeting (use Meeting Link if available) OR ask a qualifying question
- Do NOT pitch cold — they already showed interest
- Do NOT list features or write a product overview
- Do NOT use generic openers like "Thanks for reaching out" without referencing their specific interest
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best," on one line, then the rep's FIRST NAME ONLY (extracted from "Sender Name" in Rep Context) on the next line
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Your Name], etc.
- If the lead's company is missing or says "Unknown Company", simply omit company references
- MEETING LINK: If provided, embed the exact URL in a sentence. If empty, ask them to reply with availability.

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  // Pre-Meeting Email Cadence
  pre_email_1_intro: `ROLE
You are generating Email 1 in a cold outbound sequence.

GOAL
Start a conversation and trigger a reply. NOT to close, NOT to pitch.

LENGTH
40–90 words. Target 65 words. Count every word.

STRUCTURE (2–3 short paragraphs):

Paragraph 1:
Opening based on the MESSAGE FRAMEWORK provided above.
IMPORTANT: Only reference facts that appear in Lead Context or Sales Signals below. The lead's ACTUAL industry and business is defined by their company name and Lead Context — NOT by what you sell (Knowledge Context). If the lead is a crane rental company, talk about crane rentals, not your product category.

Paragraph 2 (optional, merge with CTA if possible):
One short sentence bridging to a question. Do NOT pitch. Do NOT list features. Keep it under 20 words.

Final paragraph:
CTA. One question only.
- If Custom Instructions mention "meeting" or "calendar" AND a Meeting Link is provided: end with a brief meeting invite using the EXACT Meeting Link URL (e.g., "Open to a quick chat? Here's my calendar: [exact URL]"). Do NOT mention meeting duration.
- Otherwise: use a simple micro-CTA question. No calendar links.

CRITICAL CONTEXT SEPARATION:
- "Lead Context" = WHO you are emailing (their company, role, industry). Use this for the opening.
- "Knowledge Context" = YOUR product/service. Use this ONLY to understand what angle might resonate. Do NOT describe your product to the lead. Do NOT assume the lead is in YOUR industry.
- Example: If you sell sublimation supplies and the lead runs a crane rental company, do NOT ask about "sourcing sublimation products." Instead, ask about something relevant to THEIR business (e.g., fleet branding, equipment marketing).

RULES
- Do NOT pitch the product
- Do NOT list features
- Do NOT project YOUR industry onto the lead — reference THEIR actual business
- Do NOT fabricate specifics — if you don't know what tools they use, what challenges they face, or what processes they follow, do NOT guess. Use only what's in Lead Context and Sales Signals.
- Do NOT include metrics unless extremely relevant
- Prefer 2 paragraphs over 3 when possible
- Use natural conversational tone
- Use simple punctuation
- Do NOT use em dashes (—)
- AVOID these phrases: "Given your work in", "Noticed your company", "Just checking in", "I wanted to reach out", "Hope this finds you well", "I ask because", "many businesses"
- CALENDAR LINKS: Only include if Custom Instructions explicitly request a meeting CTA AND a Meeting Link is provided. Otherwise, NO calendar links.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Sales Signals (recent intelligence — use for personalization):
{{SIGNALS}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

GREETING: Start with "Hi" followed by the prospect's first name from Lead Context (e.g., if lead name is "Jack Smith", write "Hi Jack,")
SIGN-OFF: End with "Best," on one line, then the rep's FIRST NAME ONLY on the next line
CRITICAL: Use the ACTUAL names. NEVER output bracketed placeholders like [Name], [Your Name], etc.
If the lead's company is missing, simply omit company references.
MEETING LINK: If Custom Instructions request a meeting CTA, use the EXACT URL from Meeting Link above. Do NOT invent URLs. If Meeting Link is empty, ask them to reply with availability instead.

Knowledge usage: Use ONLY to understand your product positioning. Do NOT describe your product to the lead. Do NOT assume the lead operates in your industry. Focus the email on the LEAD's world.

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  pre_email_2_followup: `ROLE
You are writing Follow-up Email 1 in a cold outbound sequence.

CONTEXT
The prospect has not replied to Email 1.

GOAL
Light reminder. Keep the conversation easy. No pitch.

LENGTH
Maximum 60 words. Count every word.

RULES
- Reference previous email briefly (one sentence max)
- Keep tone casual and friendly
- No product pitch
- One question only
- Do NOT use em dashes
- AVOID: "Just checking in", "Following up", "Circling back"

STRUCTURE
Hi {{first_name}},

[Brief reference to previous note — 1 sentence]

[One relevant question about their situation]

Best,
{{rep_first_name}}

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Previous Outreach Summary:
{{PREVIOUS_EMAIL_SUMMARY}}

Your last email said:
{{LAST_OUTBOUND_BODY}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best," on one line, then the rep's FIRST NAME ONLY on the next line
- CRITICAL: Use the ACTUAL names. NEVER output bracketed placeholders like [Name], [Your Name], etc.
- If the lead's company is missing, simply omit company references

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  pre_email_3_followup: `ROLE
You are writing Follow-up Email 2 in a cold outbound sequence.

CONTEXT
The prospect has not replied to Email 1 or Follow-up 1.

GOAL
Offer an additional angle or context. Add one small insight or observation.

LENGTH
Maximum 70 words. Count every word.

RULES
- Add one small insight, observation, or industry trend
- No product pitch
- One question only
- Do NOT repeat angles from previous emails
- Do NOT use em dashes
- AVOID: "Just checking in", "Following up", "Circling back"

STRUCTURE
Hi {{first_name}},

One quick follow-up.

[One insight or observation relevant to their industry — 1-2 sentences]

[One question connecting the insight to their situation]

Best,
{{rep_first_name}}

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Previous Outreach Summary:
{{PREVIOUS_EMAIL_SUMMARY}}

Your last email said:
{{LAST_OUTBOUND_BODY}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best," on one line, then the rep's FIRST NAME ONLY on the next line
- CRITICAL: Use the ACTUAL names. NEVER output bracketed placeholders like [Name], [Your Name], etc.
- If the lead's company is missing, simply omit company references
- Must use a DIFFERENT angle than any previous email

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  pre_email_4_breakup: `ROLE
You are writing the final email in a cold outbound sequence (Closing the Loop).

CONTEXT
The prospect has not replied to any of the previous 3 emails.

GOAL
Politely close the loop while leaving the door open. No sales language.

LENGTH
Maximum 55 words. Count every word.

RULES
- No sales language at all
- Respectful, warm tone
- Give the recipient an easy way to opt out
- Do NOT use em dashes
- Do NOT guilt trip or create urgency
- Leave door open for future contact

STRUCTURE
Hi {{first_name}},

[Acknowledge you have been reaching out — 1 sentence]

[If this is relevant later, feel free to reach out — 1 sentence]

[Otherwise close the loop — 1 sentence]

Best,
{{rep_first_name}}

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best," on one line, then the rep's FIRST NAME ONLY on the next line
- CRITICAL: Use the ACTUAL names. NEVER output bracketed placeholders like [Name], [Your Name], etc.

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  // Re-engagement Intro — for leads with existing relationship context (post-breakup/stale)
  re_engagement_intro: `ROLE
You are generating a re-engagement email for a lead you have an EXISTING relationship with. This is NOT a cold intro — you have had prior conversations, meetings, or email exchanges.

GOAL
Re-open the conversation with a fresh, relevant angle based on your shared history, milestones, and AI-recommended next steps. Do NOT repeat previous outreach angles.

CRITICAL CONTEXT:
This lead has gone quiet after previous engagement. Your last email said:
{{LAST_OUTBOUND_BODY}}

Do NOT:
- Repeat any angle, value prop, or CTA from your last email
- Write a cold intro as if you've never spoken
- Use generic openers like "I wanted to reach out" without referencing shared context
- List features or give a product overview

RELATIONSHIP CONTEXT:
Milestones from your engagement: {{MILESTONES}}
Buying signals detected: {{BUYING_SIGNALS}}
Risk signals: {{RISK_SIGNALS}}
Meeting context: {{MEETING_CONTEXT}}
Engagement level: {{ENGAGEMENT_LEVEL}}
Days since last activity: {{DAYS_SINCE_ACTIVITY}}

RE-ENGAGEMENT STRATEGY:
Choose ONE fresh angle based on the context above:
1. Reference a specific milestone or discussion point from your meetings/calls and build on it
2. Share a new development, insight, or use case relevant to their stated interests
3. Address a risk or concern that was raised and offer a resolution
4. Reference their industry/role with a timely insight that connects to your prior conversation
5. Propose a different value proposition or use case you haven't discussed yet

Previous Outreach Summary:
{{PREVIOUS_EMAIL_SUMMARY}}

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 90–140 words
- Warm, familiar tone — you know this person
- Reference your shared history naturally (meeting, prior emails, etc.)
- ONE new angle or value point
- ONE clear but low-pressure CTA
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best," on one line, then the rep's FIRST NAME ONLY on the next line
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders
- If the lead's company is missing or says "Unknown Company", simply omit company references
- MEETING LINK: If provided, embed the exact URL. If empty, ask them to reply with availability.

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  // Post-Meeting Personalized Follow-up
  post_meeting_followup_personalized: `ROLE
Generate a single personalized post-meeting follow-up email.

GOAL
Move the deal forward based on a specific objective.

CONSTRAINTS
- 100–200 words
- One clear CTA based on the goal
- Use Knowledge Context to answer questions or provide resources
- No medical or performance claims
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY on the next line with NO blank line between
- MEETING LINK EMBEDDING: CRITICAL - If a "Calendar Link" appears in Rep Context, embed the complete URL directly in a sentence
- DURATION: Do NOT mention specific meeting durations unless you can extract it from the Meeting Link URL

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Goal:
{{GOAL}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

OUTPUT
Return EMAIL BODY ONLY.`,

  // Nurture Sequence
  nurture_sequence: `ROLE
Generate a nurture email sequence.

GOAL
Maintain engagement over time with value-driven messaging.

CONSTRAINTS
- 3–6 emails depending on theme complexity
- Educational, credibility-building
- No pressure, no hard sell
- Each email 100–180 words
- Each email has ONE value point and ONE soft CTA

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Cadence:
{{CADENCE}}

Theme:
{{THEME}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

OUTPUT
Return JSON ONLY:
{
  "theme": "technical|use_case|roi|compliance",
  "cadence": "weekly|biweekly|monthly",
  "emails": [
    {"email_number": 1, "subject": "...", "body": "..."},
    {"email_number": 2, "subject": "...", "body": "..."}
  ]
}`,

  // Utility: Shorten Draft (multi-purpose one-click action)
  shorten_draft: `ROLE
You are a professional email editor performing a specific edit action on a sales email draft.

ACTION TO PERFORM: {{TARGET}}

Available actions:
- fix_grammar: Fix grammar, spelling, and improve clarity without changing meaning
- shorten_30: Shorten by ~30-40% while keeping key points and CTA
- add_meeting_cta: Update final paragraph with a stronger meeting CTA
- rewrite_tone: Rewrite the email with tone "{{TONE}}" (Friendly, Very Professional, Warm, or Concise)

INPUTS
Draft Text:
{{DRAFT_TEXT}}

Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

CONSTRAINTS
- Output a COMPLETE, ready-to-send email
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context (e.g., if lead name is "John Smith", write "Hi John,")
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY from Rep Context on the next line with NO blank line between (e.g., if Sender Name is "Sarah Johnson", write "Best regards,\nSarah")
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Rep's First Name], [Your Name], etc.
- Maintain the core message and CTA
- Keep professional tone (unless rewrite_tone specifies otherwise)
- Do NOT add any new claims or facts
- Do NOT include pricing, discounts, or commercial terms
- Preserve all grounded information from the original
- If add_meeting_cta: CRITICAL - embed the complete Calendar Link URL from Rep Context directly in a sentence if provided (e.g., "Book here: https://calendly.com/..."). Do NOT use placeholders or truncate.
- If rewrite_tone: adjust the overall tone to match "{{TONE}}" while preserving facts and intent
- No signature block - just the closing and first name

OUTPUT
Return the complete revised email body with real names (not placeholders). No JSON. No markdown.`,

  // Single Nurture Email (progressive generation)
  nurture_email_single: `ROLE
Generate the next email in a nurture sequence.

GOAL
Create one value-driven follow-up email that builds on previous emails in the sequence.

CONSTRAINTS
- 100–180 words
- Educational, credibility-building
- No pressure, no hard sell
- ONE value point and ONE soft CTA
- Must feel connected to the previous emails (not repetitive)
- Do NOT repeat talking points from previous emails
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY on the next line with NO blank line between

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Theme: {{THEME}} (technical|use_case|roi|compliance)

Email Number: {{EMAIL_NUMBER}} (1, 2, or 3)

Previous Emails in Sequence:
{{PREVIOUS_EMAILS}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

OUTPUT
Return ONLY the email body text. No JSON. No markdown. No subject line.`,

  // New: Plain-text post-meeting follow-up email (no JSON)
  post_meeting_followup_email: `ROLE
Generate a personalized follow-up email based on the meeting and FULL email thread context.

GOAL
If this is the FIRST follow-up after a meeting: Thank them, summarize key points, propose next steps.
If a follow-up was ALREADY sent (check PREVIOUS_EMAILS and LAST_OUTBOUND): Write a brief check-in referencing what was previously shared.

CRITICAL TEMPORAL AWARENESS:
- The current date is provided in the system prompt. Use it to judge recency.
- Emails or meeting references from weeks/months ago are STALE — do NOT treat them as recent context.
- If a date mentioned in the thread (e.g., "February 3rd") is in the PAST relative to today, do NOT reference it as upcoming.

CRITICAL STALENESS RULE:
{{STALE_INBOUND_INSTRUCTION}}
Examine PREVIOUS_EMAILS carefully. Determine which email is the MOST RECENT by date:
- If YOUR last outbound (LAST_OUTBOUND) is MORE RECENT than the prospect's last inbound: you are FOLLOWING UP on your own email. Do NOT reply to or reference the old inbound. Write a check-in on YOUR last outbound.
- If the prospect's last inbound is MORE RECENT than your outbound: respond to their inbound.

CRITICAL CONTEXT CHECK:
Review PREVIOUS_EMAILS and LAST_OUTBOUND before writing. If you already sent a follow-up email with:
- Materials, resources, or demo access shared
- A summary of the meeting
- Next steps already proposed
Then DO NOT:
- Say "It was great speaking with you" or "It was great talking to you today"
- Re-introduce yourself or re-summarize the meeting
- Repeat information from your last email

Instead, write a SHORT follow-up (50-100 words) asking:
- If they had a chance to review the materials
- If they have questions about what was shared
- A gentle nudge toward the next step

CONSTRAINTS
- If LAST_OUTBOUND contains materials/resources/demo access: 50-100 words check-in
- If no prior follow-up or LAST_OUTBOUND is empty: 120-200 words recap
- Professional and warm
- Reference specific topics discussed if meeting context is available
- ONE clear CTA
- No medical or performance claims
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY on the next line with NO blank line between
- MEETING LINK EMBEDDING: If a "Calendar Link" appears in Rep Context, embed the complete URL directly
- Return EMAIL BODY ONLY (no subject line, no JSON, no markdown)

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Meeting Summary (optional brief notes):
{{MEETING_SUMMARY_BRIEF}}

Previous Emails (most recent first):
{{PREVIOUS_EMAILS}}

Your Last Email Sent:
{{LAST_OUTBOUND}}

Knowledge Context (relevant to this lead):
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

OUTPUT
Return ONLY the email body text.`,
  // Match sent email to pending milestones
  match_email_to_milestones: `Analyze a sent email and determine which pending milestones it addresses.

TASK
Match the email content to pending milestones that it fulfills or completes.

INPUTS
Email Subject: {{EMAIL_SUBJECT}}
Email Body: {{EMAIL_BODY}}

Pending Milestones:
{{PENDING_MILESTONES}}

OUTPUT
Return JSON ONLY:
{
  "completed_indices": [0, 2],
  "reasoning": "Email addresses milestone #0 by sending the security documentation, and milestone #2 by sharing pricing."
}

RULES
- "completed_indices" is an array of milestone indices (0-based) that the email addresses
- Only include milestones where the email CLEARLY addresses or fulfills them
- Look for: attached documents mentioned, answers to questions, pricing info, proposals, scheduling confirmations
- If unsure, do NOT include the milestone (be conservative)
- If no milestones are addressed, return {"completed_indices": [], "reasoning": "Email does not address any pending milestones"}
- Keep reasoning to 1-2 sentences`,

  // Deduplicate milestones semantically
  dedupe_milestones: `Analyze existing milestones and identify semantic duplicates.

TASK
Given a list of milestones, identify groups that describe the same event/action.

INPUTS
Milestones:
{{MILESTONES_JSON}}

OUTPUT
Return JSON ONLY:
{
  "unique_milestones": [
    {
      "description": "Best description for this milestone",
      "status": "completed|pending",
      "date": "YYYY-MM-DD or null",
      "evidence": "...",
      "completedAt": "ISO timestamp or null",
      "merged_from": ["original desc 1", "original desc 2"]
    }
  ],
  "duplicates_removed": 3
}

RULES
- Group semantically similar milestones (e.g., "Initial meeting scheduled" and "First discovery call" are the same milestone)
- Keep the BEST description (most specific/clear)
- If ANY milestone in a group is "completed", the merged result is "completed"
- Keep the earliest date if multiple dates exist
- Keep completedAt from any completed milestone
- Merge evidence from all duplicates
- "merged_from" lists ALL original descriptions that were merged
- Single milestones with no duplicates should still appear in unique_milestones
- Be aggressive about deduplication - if milestones describe the same event, merge them`,

  // Reply to email thread
  reply_to_thread: `ROLE
You are generating a reply to an ongoing email thread in a regulated B2B sales context.

GOAL
Write a relevant, professional reply that directly addresses the latest inbound email while considering the full thread context.

CONSTRAINTS
- 80–180 words
- Directly address questions or points from the latest inbound email
- Reference previous thread context naturally if relevant
- One clear CTA (next step, meeting, or answer)
- Use Knowledge Context to provide accurate information
- No medical or performance claims
- Keep tone professional but warm
- Sign off with the Rep's first name (extract from Rep Context below) - NEVER use placeholders like [Your Name]
- Return EMAIL BODY ONLY (no subject line, no greetings like "Dear X,", start with content)

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Email Thread (most recent first):
{{EMAIL_THREAD}}

Latest Inbound Email:
{{LATEST_INBOUND}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Sales Signals (recent intelligence):
{{SIGNALS}}

Meeting Link (optional):
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

OUTPUT
Return EMAIL BODY ONLY.`,

  // Analyze outgoing email to update lead stage/next action
  analyze_outgoing_email: `ROLE
You are analyzing an outgoing sales email to determine its impact on deal progression.

GOAL
Based on the email content and lead context, suggest updates to the lead's status, stage, and next action.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Current Stage: {{CURRENT_STAGE}}
Current Next Action: {{CURRENT_NEXT_ACTION}}

Sent Email Subject: {{SENT_EMAIL_SUBJECT}}
Sent Email Body: {{SENT_EMAIL_BODY}}

ANALYSIS
Determine:
1. Should the stage change? (e.g., new → contacted, contacted → engaged if multi-touch)
2. What's the appropriate next action for follow-up?
3. Does the lead still need immediate action or is it waiting for a response?

RULES
- If this is a first outreach email, stage should be "contacted"
- If this is a follow-up email after engagement, stage stays "engaged" or higher
- After sending, typically needs_action should be FALSE (waiting for reply)
- Next action should be a logical follow-up (e.g., "send_pre_2", "wait_reply", "schedule_meeting")
- Keep reasoning factual and brief

OUTPUT FORMAT
Return JSON only:
{
  "suggested_stage": "new|contacted|engaged|post_meeting|closing|closed_won|closed_lost",
  "next_action_key": "wait_reply|send_pre_2|send_pre_3|send_pre_4|schedule_meeting|send_followup|null",
  "next_action_label": "Human readable next action label or null",
  "needs_action": false,
  "reasoning": "Brief explanation of the analysis (1-2 sentences)"
}`,

  // WhatsApp short-form message
  whatsapp_message: `ROLE
You are writing a short WhatsApp message for a B2B sales context.

GOAL
Send a quick, natural, conversational message. This is NOT an email — it's a text message.

FORMAT RULES (MANDATORY)
- Maximum 60 words
- NO greeting like "Dear" or "Hello" — start with "Hey [first name]," or "Hi [first name],"
- NO sign-off like "Best regards", "Thanks", "Warm regards" — just end naturally
- NO signature block, NO "[Rep's first name]", NO placeholders
- 2-3 short sentences maximum
- Casual, direct, friendly tone
- One emoji max, only if natural
- One soft CTA (question or suggestion)
- NO subject line

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

OUTPUT
Return the WhatsApp message text ONLY. No JSON. No markdown.`,

  // ── WhatsApp intent classifier ──────────────────────────
  whatsapp_classify_intent: `You are an AI intent classifier for WhatsApp business messages.

TASK
Classify the intent of the following inbound WhatsApp message.

INPUT
Message: {{MESSAGE_TEXT}}
Lead Stage: {{LEAD_STAGE}}

INTENTS (choose one):
- acknowledgment: simple confirmation, thanks, or positive reception
- scheduling: asking about or confirming a meeting/call
- clarification: asking a question about the product/service
- objection: expressing concern, hesitation, or pushback
- complaint: expressing dissatisfaction or reporting an issue
- unsubscribe: asking to be removed or stop contact
- negotiation: discussing pricing, terms, or conditions
- legal: mentioning lawyers, contracts, compliance, lawsuits
- positive_interest: expressing clear buying intent
- unknown: cannot determine intent

RISK FLAGS (list zero or more):
- "pricing_sensitivity": mentions cost concerns
- "competitor_mention": mentions a competing product
- "legal_risk": mentions legal action or compliance
- "churn_risk": indicates intent to cancel or leave
- "escalation_needed": human must handle this

OUTPUT
Respond with ONLY valid JSON (no markdown, no explanation):
{
  "intent": "<intent>",
  "confidence": <float between 0.0 and 1.0>,
  "risk_flags": ["<flag1>", "<flag2>"]
}`,

  // ── WhatsApp auto-reply suggestion ─────────────────────
  whatsapp_reply_suggestion: `You are an AI writing an automated WhatsApp reply for a B2B sales context.

TASK
Generate a short, natural WhatsApp reply to the inbound message below.

CONTEXT
Inbound Message: {{MESSAGE_TEXT}}
Detected Intent: {{INTENT}}
Lead Stage: {{LEAD_STAGE}}
Lead Name: {{LEAD_NAME}}

FORMAT RULES (MANDATORY)
- Maximum 50 words
- Start with "Hey {{LEAD_NAME}}," or "Hi {{LEAD_NAME}},"
- NO sign-off or signature
- 1-2 sentences only
- Conversational, friendly, professional
- One clear next step or question
- NO placeholders in the final output

SAFETY
- Never make pricing commitments
- Never make legal statements
- If intent is unclear, ask a clarifying question
- If topic is sensitive (legal, complaint), acknowledge and say a human will follow up

OUTPUT
Return the WhatsApp message text ONLY. No JSON. No markdown.`,
};

// --- STRATEGY 2: Model Tiering ---
// Pro model: deep analytical tasks only
// Note: reply_to_thread and post_meeting_followup_email removed — now handled by client model_hint
const PRO_MODEL_TASKS = [
  "post_meeting_recap",
  "extract_milestones_risks",
  "extract_deal_factors",
  "recommend_next_steps",
  "lead_deep_analysis",
  "post_meeting_followup_personalized",
  // reply_to_thread → uses model_hint from complexity scorer (Flash for simple, Pro for complex)
  // post_meeting_followup_email → uses model_hint from complexity scorer
];

// Lite model: simple classification/analysis tasks
const LITE_MODEL_TASKS = [
  "intent_router",
  "analyze_outgoing_email",
];

function replaceTemplateVars(template: string, payload: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(payload)) {
    const placeholder = `{{${key.toUpperCase()}}}`;
    const replacement = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    result = result.split(placeholder).join(replacement);
  }
  // Remove any remaining placeholders
  result = result.replace(/\{\{[A-Z_]+\}\}/g, "");
  return result;
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify JWT authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Check if this is a service-role call (from automation-executor)
    const token = authHeader.replace("Bearer ", "");
    const isServiceRole = token === supabaseServiceKey;
    
    let user: { id: string } | null = null;
    
    if (isServiceRole) {
      // Service role calls are trusted (from internal edge functions)
      // Use a system user ID placeholder
      user = { id: "service-role" };
    } else {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
      if (authError || !authUser) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = authUser;
    }

    const { task, payload } = await req.json();

    if (!task || typeof task !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing or invalid task" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const taskPrompt = PROMPTS[task];
    if (!taskPrompt) {
      return new Response(JSON.stringify({ ok: false, error: `Unknown task: ${task}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY is not configured");
      return new Response(JSON.stringify({ ok: false, error: "AI gateway not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Default cadence settings (single source of truth)
    const DEFAULT_CADENCE_SETTINGS = {
      version: 1,
      modes: {
        fast: {
          reply_pending_hours: 4,
          outbound_followups_days: [2, 3, 3, 4],
          breakup_trigger: { days_since_first_outbound: 10, days_since_last_outbound: 5 },
          post_meeting: { recap_suggest_after_hours: 4, checkins_days: [3, 7] },
        },
        nurture: {
          reply_pending_hours: 24,
          outbound_followups_days: [5, 7, 7, 10],
          breakup_trigger: { days_since_first_outbound: 30, days_since_last_outbound: 14 },
          post_meeting: { recap_suggest_after_hours: 24, checkins_days: [7, 14, 30] },
        },
      },
      flows: {
        nurture_campaigns: {
          enabled: true,
          cadences_days: { weekly: 7, biweekly: 14, monthly: 30 },
          min_days_after_last_touch: 7,
        },
      },
    };

    // Enhance payload with semantic knowledge search for relevant tasks
    let enhancedPayload = { ...payload };
    let knowledgeContextUsed = false;

    // Load cadence settings from workspace if available — run in parallel with KB search later
    let cadenceSettings = DEFAULT_CADENCE_SETTINGS;
    let cadencePromise: Promise<void> = Promise.resolve();
    if (payload?.lead_id) {
      cadencePromise = (async () => {
        try {
          const supabaseServiceKeyInner = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
          const adminClient = createClient(supabaseUrl, supabaseServiceKeyInner);
          
          // Single JOIN query instead of 2 sequential queries
          const { data: combined } = await adminClient
            .from("leads")
            .select("owner_user_id, workspace_profiles!inner(cadence_settings)")
            .eq("id", payload.lead_id)
            .maybeSingle();
          
          const wsCadence = (combined as any)?.workspace_profiles?.cadence_settings;
          if (wsCadence) {
            cadenceSettings = {
              ...DEFAULT_CADENCE_SETTINGS,
              ...wsCadence,
              modes: {
                fast: { ...DEFAULT_CADENCE_SETTINGS.modes.fast, ...wsCadence?.modes?.fast },
                nurture: { ...DEFAULT_CADENCE_SETTINGS.modes.nurture, ...wsCadence?.modes?.nurture },
              },
            };
            console.log(`[ai_task] Loaded workspace cadence settings (joined)`);
          }
        } catch (err) {
          console.error("[ai_task] Failed to load cadence settings, using defaults:", err);
        }
      })();
    }

    // Inject cadence_days for followup_sequence_4 task
    if (task === "followup_sequence_4") {
      const mode = (payload?.mode || "fast") as "fast" | "nurture";
      const cadenceDays = cadenceSettings.modes[mode]?.outbound_followups_days || [2, 3, 3, 4];
      enhancedPayload.cadence_days = JSON.stringify(cadenceDays);
      console.log(`[ai_task] Injected cadence_days for ${mode} mode: ${JSON.stringify(cadenceDays)}`);
    }
    
    // Read motion flags early (needed for KB gating)
    const motion = String(enhancedPayload.motion || "");
    const isFirstTouch = enhancedPayload.first_touch === true;
    const isOutboundFirstTouch = motion === "outbound_prospecting" && isFirstTouch;

    // ── Context Cache: read precomputed intelligence if available ──
    let contextCachePromise: Promise<Record<string, unknown> | null> = Promise.resolve(null);
    if (payload?.lead_id) {
      contextCachePromise = (async () => {
        try {
          const cacheClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data } = await cacheClient
            .from("lead_context_cache")
            .select("context_json, last_generated_at")
            .eq("lead_id", payload.lead_id)
            .maybeSingle();

          if (data) {
            const age = Date.now() - new Date(data.last_generated_at).getTime();
            const MAX_AGE = 6 * 60 * 60 * 1000; // 6 hours
            if (age < MAX_AGE) {
              console.log(`[ai_task] ✅ Context cache hit for lead ${payload.lead_id}, age: ${Math.round(age / 60000)}min`);
              return data.context_json as Record<string, unknown>;
            }
            console.log(`[ai_task] Context cache expired for lead ${payload.lead_id}`);
          }
          return null;
        } catch (err) {
          console.error("[ai_task] Context cache lookup failed:", err);
          return null;
        }
      })();
    }

    // Fetch lead_signals for AI context injection
    let signalsPromise: Promise<{ type: string; description: string; source: string }[]> = Promise.resolve([]);
    if (payload?.lead_id) {
      signalsPromise = (async () => {
        try {
          const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data } = await adminClient
            .from("lead_signals")
            .select("signal_type, signal_description, source_url")
            .eq("lead_id", payload.lead_id)
            .order("detected_at", { ascending: false })
            .limit(8);
          return (data || []).map((s: any) => ({
            type: s.signal_type,
            description: s.signal_description,
            source: s.source_url || "",
          }));
        } catch (err) {
          console.error("[ai_task] Failed to load lead_signals:", err);
          return [];
        }
      })();
    }

    // Run cadence fetch AND KB search AND signals fetch AND context cache in parallel
    let kbSearchPromise: Promise<{ formatted: string; grouped: KBChunksGrouped }> = Promise.resolve({ formatted: "", grouped: {} });
    if (KNOWLEDGE_SEARCH_TASKS.includes(task)) {
      const queryParts: string[] = [];
      if (payload?.email_text) queryParts.push(String(payload.email_text));
      if (payload?.questions_list) queryParts.push(String(payload.questions_list));
      if (payload?.lead_context) queryParts.push(String(payload.lead_context).slice(0, 500));
      if (payload?.meeting_summary) queryParts.push(String(payload.meeting_summary).slice(0, 500));
      const searchQuery = queryParts.join("\n").slice(0, 2000);

      if (searchQuery.length > 50) {
        const supabaseServiceKeyForKb = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const leadId = payload?.lead_id ? String(payload.lead_id) : undefined;
        console.log(`[ai_task] Searching knowledge base. Query length: ${searchQuery.length}, lead_id: ${leadId || 'global'}`);
        kbSearchPromise = getKnowledgeContext(searchQuery, supabaseUrl, supabaseServiceKeyForKb, user.id, leadId, task);
      }
    }

    // ── Message Diversity: fetch recent generation patterns ──
    let diversityPromise: Promise<DiversityConstraints> = Promise.resolve({
      avoid_opening_types: [], avoid_angles: [], avoid_cta_types: [],
      preferred_angles: [], preferred_cta_types: [],
    });
    // Resolve workspace_id for diversity lookups
    let resolvedWorkspaceId: string | null = null;
    if (payload?.lead_id && OUTREACH_TASKS.has(task)) {
      diversityPromise = (async () => {
        try {
          const divClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          // Resolve workspace from lead ownership
          const { data: membership } = await divClient
            .from("workspace_members")
            .select("workspace_id")
            .eq("user_id", isServiceRole ? "service-role" : user.id)
            .limit(1)
            .maybeSingle();
          resolvedWorkspaceId = membership?.workspace_id || null;
          return buildDiversityConstraints(
            divClient, String(payload.lead_id), resolvedWorkspaceId,
            payload?.campaign_id ? String(payload.campaign_id) : null
          );
        } catch (err) {
          console.error("[ai_task] Diversity fetch failed:", err);
          return { avoid_opening_types: [], avoid_angles: [], avoid_cta_types: [], preferred_angles: [], preferred_cta_types: [] };
        }
      })();
    }

    // Await all in parallel
    const [kbResult, , leadSignals, cachedContext, diversityConstraints] = await Promise.all([
      kbSearchPromise, cadencePromise, signalsPromise, contextCachePromise, diversityPromise,
    ]);

    // Inject cached context if available — enriches the payload with precomputed intelligence
    if (cachedContext) {
      // Inject recommended angles as custom context
      if (Array.isArray(cachedContext.recommended_angles) && (cachedContext.recommended_angles as string[]).length > 0) {
        const anglesStr = (cachedContext.recommended_angles as string[]).join("\n- ");
        enhancedPayload.recommended_angles = `Recommended outreach angles:\n- ${anglesStr}`;
      }
      // Inject company summary and interactions summary as supplementary context
      if (cachedContext.company_summary) {
        enhancedPayload.company_intelligence = String(cachedContext.company_summary);
      }
      if (cachedContext.previous_interactions_summary) {
        enhancedPayload.interaction_summary = String(cachedContext.previous_interactions_summary);
      }
      if (cachedContext.industry_context && String(cachedContext.industry_context) !== "No industry-specific context available.") {
        enhancedPayload.industry_intelligence = String(cachedContext.industry_context);
      }
      // Use cached signals if live signals are empty
      if (leadSignals.length === 0 && Array.isArray(cachedContext.signals) && (cachedContext.signals as any[]).length > 0) {
        enhancedPayload.signals = JSON.stringify(cachedContext.signals);
        console.log(`[ai_task] ✅ Injected ${(cachedContext.signals as any[]).length} signals from context cache`);
      }
    }

    // Inject live lead signals into context (takes priority over cached)
    if (leadSignals.length > 0) {
      enhancedPayload.signals = JSON.stringify(leadSignals);
      console.log(`[ai_task] ✅ Injected ${leadSignals.length} lead signals into context`);
    }

    if (kbResult.formatted) {
      // For outbound first touch, apply stricter cap
      if (isOutboundFirstTouch) {
        const capped = kbResult.formatted.slice(0, 600);
        enhancedPayload.knowledge_context = capped;
        knowledgeContextUsed = true;
        console.log(`[ai_task] ✅ KB context capped for first touch: ${capped.length}/${kbResult.formatted.length} chars`);
      } else {
        enhancedPayload.knowledge_context = kbResult.formatted;
        knowledgeContextUsed = true;
        console.log(`[ai_task] ✅ Structured KB context (${kbResult.formatted.length} chars, types: ${Object.keys(kbResult.grouped).join(",")})`);
      }
    } else if (KNOWLEDGE_SEARCH_TASKS.includes(task)) {
      console.log(`[ai_task] ⚠️ No KB matches found for task ${task}`);
    }

    // Remaining explicit flags (motion/isFirstTouch already read above)
    const playbookId = String(enhancedPayload.playbook_id || "general");
    const hasInbound = enhancedPayload.has_latest_inbound === true;

    console.log(`[ai_task] Flags — playbook: ${playbookId}, motion: ${motion}, first_touch: ${isFirstTouch}, has_inbound: ${hasInbound}`);

    // Gate meeting_link: only pass to cold outbound tasks if custom instructions explicitly request it
    const COLD_OUTBOUND_TASKS = new Set(["pre_email_1_intro", "pre_email_2_followup", "pre_email_3_followup", "pre_email_4_breakup", "re_engagement_intro"]);
    if (COLD_OUTBOUND_TASKS.has(task) && enhancedPayload.meeting_link) {
      const instructions = String(enhancedPayload.custom_instructions || "").toLowerCase();
      const mentionsMeeting = /meeting|calendar|book.*time|schedule.*call|meeting.*cta|include.*cta/i.test(instructions);
      if (!mentionsMeeting) {
        console.log(`[ai_task] 🚫 Stripped meeting_link for ${task} — not requested in custom instructions`);
        delete enhancedPayload.meeting_link;
      } else {
        console.log(`[ai_task] ✅ Meeting link kept for ${task} — requested in custom instructions`);
      }
    }

    // Build the task prompt with template variables replaced
    const taskBody = replaceTemplateVars(taskPrompt, enhancedPayload);

    // Compute all blocks
    const isOutboundMotion = motion === "outbound_prospecting";
    const outboundStyle = String(enhancedPayload.outbound_style || "standard");
    const isFollowUp = task === "pre_email_2_followup" || task === "pre_email_3_followup" || task === "pre_email_4_breakup";
    const isBreakup = task === "pre_email_4_breakup";

    // 1. Motion block
    const motionBlock = buildMotionBlock({ motion, first_touch: isFirstTouch });

    // 2. Style modifier (combine all style pieces into one string)
    const styleParts: string[] = [];
    const styleBlock = buildStyleModifier({ motion, first_touch: isFirstTouch, outbound_style: outboundStyle });
    if (styleBlock) styleParts.push(styleBlock);
    if (isFirstTouch && isOutboundMotion && !hasInbound) styleParts.push(getColdOutreachBlock(playbookId));
    if (isFollowUp && isOutboundMotion) styleParts.push(REPLY_PATTERNS_BLOCK);
    if (isBreakup) styleParts.push(BREAKUP_CLOSERS[playbookId] || BREAKUP_CLOSERS.general_sales);
    const styleModifier = styleParts.join("\n\n") || "";

    // 3. Playbook context
    const playbookContext = enhancedPayload.playbook_context ? String(enhancedPayload.playbook_context) : "";

    // 4. Diversity constraints (injected for outreach tasks)
    const hasDiversityConstraints = OUTREACH_TASKS.has(task) && (
      diversityConstraints.avoid_opening_types.length > 0 ||
      diversityConstraints.avoid_angles.length > 0 ||
      diversityConstraints.avoid_cta_types.length > 0
    );
    const diversityBlock = hasDiversityConstraints ? formatDiversityBlock(diversityConstraints) : "";
    if (diversityBlock) console.log("[ai_task] [4/DIVERSITY] Constraints injected");

    // 5. Channel + Sequence framework — resolve channel, detect step, select framework
    const resolvedChannel = resolveChannel(task, payload?.channel ? String(payload.channel) : undefined);
    const sequenceStep = resolveSequenceStep(task, payload?.sequence_step);
    
    // Sequence-aware framework overrides generic channel framework when step is known
    let messagingFrameworkBlock = "";
    if (sequenceStep && !CHANNEL_FRAMEWORK_EXEMPT_TASKS.has(task)) {
      messagingFrameworkBlock = getSequenceFramework(resolvedChannel, sequenceStep);
    }
    // Fall back to generic channel framework if no sequence step
    if (!messagingFrameworkBlock) {
      messagingFrameworkBlock = getChannelFramework(task, resolvedChannel);
    }
    if (messagingFrameworkBlock) console.log(`[ai_task] [5/CHANNEL] ${resolvedChannel}${sequenceStep ? ` step=${sequenceStep}` : " (generic)"}`);

    // 6. Email Framework Router — select and inject framework for cold outreach emails
    let emailFrameworkBlock = "";
    let selectedFramework: EmailFramework | null = null;
    const isOutboundEmailTask = task === "pre_email_1_intro" || task === "email_intro_fast" || task === "re_engagement_intro";
    if (isOutboundEmailTask && isOutboundMotion) {
      selectedFramework = selectEmailFramework(
        leadSignals,
        enhancedPayload.industry ? String(enhancedPayload.industry) : undefined,
        enhancedPayload.lead_context ? String(enhancedPayload.lead_context) : undefined,
      );
      emailFrameworkBlock = getEmailFrameworkBlock(selectedFramework);
      console.log(`[ai_task] [6/FRAMEWORK] Selected: ${selectedFramework} (signals: ${leadSignals.length})`);
    }

    // Build final prompt in one pass: motion → style → channel/sequence → framework → diversity → playbook → task
    const promptParts: string[] = [];
    if (motionBlock) promptParts.push(motionBlock);
    if (styleModifier) promptParts.push(styleModifier);
    if (messagingFrameworkBlock) promptParts.push(messagingFrameworkBlock);
    if (emailFrameworkBlock) promptParts.push(emailFrameworkBlock);
    if (diversityBlock) promptParts.push(diversityBlock);
    if (playbookContext) promptParts.push(playbookContext);
    promptParts.push(taskBody);
    const userPrompt = promptParts.join("\n\n");

    // Log what was assembled
    if (motionBlock) console.log(`[ai_task] [1/MOTION] ${motion}${isFirstTouch ? " (first_touch)" : ""}`);
    if (styleModifier) console.log(`[ai_task] [2/STYLE] ${styleParts.length} block(s)`);
    if (playbookContext) console.log("[ai_task] [3/PLAYBOOK] Playbook context");
    console.log(`[ai_task] Channel: ${resolvedChannel}, Step: ${sequenceStep ?? "none"}, Framework: ${selectedFramework ?? "none"}`);


    // Select model: honor client-side model_hint (from complexity scorer) if provided,
    // otherwise fall back to server-side task tier
    const clientModelHint = payload?.model_hint ? String(payload.model_hint) : null;
    const model = clientModelHint && ["google/gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"].includes(clientModelHint)
      ? clientModelHint
      : PRO_MODEL_TASKS.includes(task)
        ? "google/gemini-2.5-pro"
        : LITE_MODEL_TASKS.includes(task)
          ? "google/gemini-2.5-flash-lite"
          : "google/gemini-2.5-flash";

    console.log(`[ai_task] Task: ${task}, Model: ${model}, User: ${user.id}`);

    // Check if client requested streaming
    const streamRequested = payload?.stream === true;

    const aiRequestBody: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: `${SYSTEM_GLOBAL_PROMPT}\n\nCurrent date: ${new Date().toISOString().split('T')[0]}` },
        { role: "user", content: userPrompt },
      ],
    };

    if (streamRequested) {
      aiRequestBody.stream = true;
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(aiRequestBody),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded. Please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ ok: false, error: "Payment required. Please add credits to continue." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error(`[ai_task] AI gateway error: ${response.status}`, errorText);
      return new Response(JSON.stringify({ ok: false, error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Streaming path: pipe SSE directly to client
    if (streamRequested && response.body) {
      console.log(`[ai_task] Streaming response for task: ${task}`);
      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    // Non-streaming path: buffer full response
    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || "";

    // Word count logging for outbound first touch
    if (isOutboundFirstTouch && content) {
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      console.log(`[ai_task] Outbound first touch word count: ${wordCount}`);
    }

    // ── Quality Scoring: evaluate and optionally regenerate outbound emails ──
    let qualityScore: EmailQualityScore | null = null;
    let regenerated = false;

    if (QUALITY_SCORED_TASKS.has(task) && content && !streamRequested) {
      try {
        const scoreResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [
              { role: "system", content: QUALITY_SCORER_PROMPT },
              { role: "user", content: `Email to evaluate:\n\n${content}` },
            ],
          }),
        });

        if (scoreResp.ok) {
          const scoreData = await scoreResp.json();
          const scoreContent = scoreData.choices?.[0]?.message?.content || "";
          const cleaned = scoreContent.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
          try {
            // Extract JSON from potential wrapper text
            const jsonStart = cleaned.indexOf("{");
            const jsonEnd = cleaned.lastIndexOf("}");
            if (jsonStart >= 0 && jsonEnd > jsonStart) {
              qualityScore = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
            }
          } catch { /* scoring parse failed, continue without */ }
        } else {
          await scoreResp.text(); // consume body
        }

        if (qualityScore) {
          const total = qualityScore.curiosity + qualityScore.human_tone + qualityScore.spam_risk + qualityScore.reply_likelihood;
          console.log(`[ai_task] Quality score: ${total}/40 (C:${qualityScore.curiosity} H:${qualityScore.human_tone} S:${qualityScore.spam_risk} R:${qualityScore.reply_likelihood})`);

          // If score below threshold, regenerate once using curiosity framework
          if (total < QUALITY_THRESHOLD) {
            console.log(`[ai_task] ⚠️ Score ${total} < ${QUALITY_THRESHOLD} — regenerating with curiosity framework`);
            const curiosityFramework = getEmailFrameworkBlock("curiosity");
            const regenParts = promptParts.filter(p => !Object.values(EMAIL_FRAMEWORK_BLOCKS).includes(p));
            // Insert curiosity framework before task body
            const taskIdx = regenParts.indexOf(taskBody);
            if (taskIdx >= 0) {
              regenParts.splice(taskIdx, 0, curiosityFramework);
            } else {
              regenParts.push(curiosityFramework);
            }
            const regenPrompt = regenParts.join("\n\n");

            const regenResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${LOVABLE_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model,
                messages: [
                  { role: "system", content: `${SYSTEM_GLOBAL_PROMPT}\n\nCurrent date: ${new Date().toISOString().split('T')[0]}` },
                  { role: "user", content: regenPrompt },
                ],
              }),
            });

            if (regenResp.ok) {
              const regenData = await regenResp.json();
              const regenContent = regenData.choices?.[0]?.message?.content || "";
              if (regenContent) {
                content = regenContent;
                regenerated = true;
                console.log(`[ai_task] ✅ Regenerated email (curiosity framework), length: ${content.length}`);
              }
            } else {
              await regenResp.text(); // consume body
              console.warn("[ai_task] Regeneration failed, using original email");
            }
          }
        }
      } catch (err) {
        console.error("[ai_task] Quality scoring failed (non-blocking):", err);
      }
    }

    console.log(`[ai_task] Success. Response length: ${content.length}, knowledge_used: ${knowledgeContextUsed}, quality_scored: ${!!qualityScore}, regenerated: ${regenerated}`);

    // ── Post-generation: Diversity logging (fire-and-forget for outreach tasks) ──
    if (OUTREACH_TASKS.has(task) && content && payload?.lead_id && resolvedWorkspaceId) {
      const capturedStep = sequenceStep;
      const capturedChannel = resolvedChannel;
      (async () => {
        try {
          const logClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

          // Classify the generated message (run early so we can log even if similarity check fails)
          const classifyResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [{ role: "user", content: CLASSIFY_MESSAGE_PROMPT + content.slice(0, 2000) }],
            }),
          });

          let classification = {
            opening_type: "observation",
            primary_angle: "general",
            secondary_angle: null as string | null,
            cta_type: "quick_question",
            tone: "professional",
          };

          if (classifyResp.ok) {
            const classifyData = await classifyResp.json();
            const classifyContent = classifyData.choices?.[0]?.message?.content || "";
            const cleaned = classifyContent.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
            try {
              const parsed = JSON.parse(cleaned);
              classification = { ...classification, ...parsed };
            } catch { /* use defaults */ }
          } else {
            await classifyResp.text(); // consume body
          }

          // Generate embedding for the message
          let embedding: number[] | null = null;
          const openaiKey = Deno.env.get("OPENAI_API_KEY");
          if (openaiKey) {
            embedding = await generateQueryEmbedding(content.slice(0, 4000), openaiKey);
          }

          // Similarity check: embedding-based (cosine > 0.85) then text fallback (Jaccard > 0.6)
          const { data: recentMsgs } = await logClient
            .from("message_generation_log")
            .select("generated_message, message_embedding")
            .eq("lead_id", payload.lead_id)
            .order("created_at", { ascending: false })
            .limit(5);

          if (recentMsgs && recentMsgs.length > 0) {
            let highEmbeddingSim = false;

            // Embedding-based cosine similarity check
            if (embedding && recentMsgs.some((m: any) => m.message_embedding)) {
              for (const m of recentMsgs) {
                if (!m.message_embedding) continue;
                try {
                  const stored = typeof m.message_embedding === "string"
                    ? JSON.parse(m.message_embedding)
                    : m.message_embedding;
                  if (Array.isArray(stored) && stored.length === embedding.length) {
                    let dot = 0, normA = 0, normB = 0;
                    for (let i = 0; i < embedding.length; i++) {
                      dot += embedding[i] * stored[i];
                      normA += embedding[i] * embedding[i];
                      normB += stored[i] * stored[i];
                    }
                    const cosineSim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
                    if (cosineSim > 0.85) {
                      highEmbeddingSim = true;
                      console.warn(`[ai_task] ⚠️ High embedding similarity (${cosineSim.toFixed(3)}) — message may be too similar`);
                      break;
                    }
                  }
                } catch { /* skip malformed embeddings */ }
              }
            }

            // Text-based fallback similarity
            if (!highEmbeddingSim) {
              const maxTextSim = Math.max(...recentMsgs.map((m: any) => textSimilarity(content, m.generated_message)));
              if (maxTextSim > 0.6) {
                console.warn(`[ai_task] ⚠️ High text similarity (${maxTextSim.toFixed(2)}) to recent message`);
              }
            }
          }

          // Store in message_generation_log with sequence_step
          await logClient.from("message_generation_log").insert({
            workspace_id: resolvedWorkspaceId,
            lead_id: payload.lead_id,
            campaign_id: payload.campaign_id || null,
            channel: capturedChannel,
            task_type: task,
            sequence_step: capturedStep,
            generated_message: content.slice(0, 10000),
            opening_type: classification.opening_type,
            primary_angle: classification.primary_angle,
            secondary_angle: classification.secondary_angle,
            cta_type: classification.cta_type,
            tone: classification.tone,
            message_embedding: embedding ? JSON.stringify(embedding) : null,
          });

          console.log(`[ai_task] ✅ Diversity log saved: ch=${capturedChannel}, step=${capturedStep ?? "-"}, opening=${classification.opening_type}, angle=${classification.primary_angle}, cta=${classification.cta_type}`);
        } catch (err) {
          console.error("[ai_task] Diversity logging failed (non-blocking):", err);
        }
      })();
    }

    const responsePayload: Record<string, unknown> = {
      ok: true,
      content,
      raw: data,
      knowledge_context_used: knowledgeContextUsed,
    };

    // Include quality score and framework info for scored email tasks
    if (qualityScore) {
      responsePayload.quality_score = qualityScore;
      responsePayload.regenerated = regenerated;
    }
    if (selectedFramework) {
      responsePayload.framework_used = selectedFramework;
    }

    return new Response(
      JSON.stringify(responsePayload),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[ai_task] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "An error occurred while processing your request", error_id: errorId }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
