import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Import from shared modules
import { SYSTEM_GLOBAL_PROMPT, PROMPTS, QUALITY_SCORER_PROMPT, CLASSIFY_MESSAGE_PROMPT, GROUNDING_VALIDATOR_PROMPT } from "../_shared/prompts.ts";
import {
  CHANNEL_FRAMEWORKS, CHANNEL_FRAMEWORK_EXEMPT_TASKS,
  resolveSequenceStep, getSequenceFramework, resolveChannel, getChannelFramework,
  COLD_OUTREACH_STYLE_BLOCK, getColdOutreachBlock, REPLY_PATTERNS_BLOCK, BREAKUP_CLOSERS,
  type EmailFramework, selectEmailFramework, getEmailFrameworkBlock,
  buildMotionBlock, buildStyleModifier,
} from "../_shared/frameworks.ts";

// ============================================
// MESSAGE DIVERSITY CONTROL
// ============================================

const OPENING_TYPES = ["observation", "problem", "trigger_event", "compliment", "direct_offer", "question", "followup_reference", "breakup"] as const;
const CTA_TYPES = ["quick_question", "soft_offer", "meeting_request", "permission_based", "timing_check", "breakup_close"] as const;

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

async function buildDiversityConstraints(
  adminClient: ReturnType<typeof createClient>,
  leadId: string,
  workspaceId: string | null,
  campaignId: string | null,
): Promise<DiversityConstraints> {
  const constraints: DiversityConstraints = {
    avoid_opening_types: [], avoid_angles: [], avoid_cta_types: [],
    preferred_angles: [], preferred_cta_types: [],
  };

  try {
    const { data: leadMessages } = await adminClient
      .from("message_generation_log")
      .select("opening_type, primary_angle, cta_type, sequence_step, channel")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(8);

    if (leadMessages && leadMessages.length > 0) {
      const recentOpenings = leadMessages.slice(0, 3).map((m: any) => m.opening_type).filter(Boolean);
      const recentAngles = leadMessages.map((m: any) => m.primary_angle).filter(Boolean);
      const recentCtas = leadMessages.slice(0, 2).map((m: any) => m.cta_type).filter(Boolean);

      constraints.avoid_opening_types = [...new Set(recentOpenings)];
      constraints.avoid_cta_types = [...new Set(recentCtas)];

      const angleCounts = new Map<string, number>();
      for (const angle of recentAngles) {
        angleCounts.set(angle, (angleCounts.get(angle) || 0) + 1);
      }
      for (const [angle, count] of angleCounts) {
        if (count >= 2) constraints.avoid_angles.push(angle);
      }
    }

    if (workspaceId) {
      const { data: campaignMessages } = await adminClient
        .from("message_generation_log")
        .select("opening_type, cta_type")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (campaignMessages && campaignMessages.length >= 5) {
        const usedOpenings = new Set(campaignMessages.map((m: any) => m.opening_type).filter(Boolean));
        const usedCtas = new Set(campaignMessages.map((m: any) => m.cta_type).filter(Boolean));

        for (const ot of OPENING_TYPES) {
          if (!usedOpenings.has(ot) && !constraints.avoid_opening_types.includes(ot)) {
            constraints.preferred_angles.push(ot);
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

function formatDiversityBlock(constraints: DiversityConstraints): string {
  const parts: string[] = [];
  parts.push("=== MESSAGE DIVERSITY CONSTRAINTS ===");
  parts.push("To ensure fresh, varied outreach, follow these constraints:");
  if (constraints.avoid_opening_types.length > 0) parts.push(`- DO NOT use these opening styles (recently used): ${constraints.avoid_opening_types.join(", ")}`);
  if (constraints.avoid_angles.length > 0) parts.push(`- DO NOT use these angles/themes (overused): ${constraints.avoid_angles.join(", ")}`);
  if (constraints.avoid_cta_types.length > 0) parts.push(`- DO NOT use these CTA types (recently used): ${constraints.avoid_cta_types.join(", ")}`);
  if (constraints.preferred_cta_types.length > 0) parts.push(`- PREFER one of these fresh CTA styles: ${constraints.preferred_cta_types.slice(0, 3).join(", ")}`);
  parts.push("- Maintain brand voice consistency while varying approach");
  parts.push("- Quality and relevance always take priority over forced variation");
  return parts.join("\n");
}

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

// ============================================
// KNOWLEDGE BASE CONFIG & RETRIEVAL
// ============================================

const TASK_KB_CONFIG: Record<string, string[]> = {
  email_intro_fast: ["messaging", "knowledge", "industry"],
  email_intro_nurture: ["messaging", "knowledge", "industry"],
  pre_email_1_intro: ["messaging", "knowledge", "industry"],
  inbound_intro: ["messaging", "knowledge", "industry"],
  re_engagement_intro: ["messaging", "knowledge", "industry"],
  followup_sequence_4: ["messaging", "knowledge"],
  linkedin_followup: ["messaging", "knowledge"],
  reply_to_thread: ["knowledge", "objection", "messaging"],
  answer_questions: ["knowledge", "objection", "messaging"],
  post_meeting_recap: ["knowledge", "discovery", "strategy"],
  post_meeting_followup_personalized: ["knowledge", "discovery", "strategy"],
  post_meeting_followup_email: ["knowledge", "discovery"],
  nurture_sequence: ["messaging", "industry"],
  nurture_email_single: ["messaging", "industry"],
  extract_milestones_risks: ["strategy", "signal"],
  extract_deal_factors: ["strategy", "signal"],
  recommend_next_steps: ["strategy", "signal", "knowledge"],
  lead_deep_analysis: ["strategy", "signal", "industry"],
};

const KNOWLEDGE_SEARCH_TASKS = Object.keys(TASK_KB_CONFIG);
const MAX_KB_CHUNKS = 4;

const ANALYSIS_TASKS = new Set([
  "post_meeting_recap", "post_meeting_followup_personalized", "post_meeting_followup_email",
  "extract_milestones_risks", "extract_deal_factors", "recommend_next_steps", "lead_deep_analysis",
]);
const KB_CHAR_LIMIT_OUTBOUND = 1200;
const KB_CHAR_LIMIT_ANALYSIS = 2400;

function getKbCharLimit(task: string): number {
  return ANALYSIS_TASKS.has(task) ? KB_CHAR_LIMIT_ANALYSIS : KB_CHAR_LIMIT_OUTBOUND;
}

interface KBChunksGrouped { [contentType: string]: string; }

async function generateQueryEmbedding(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
    });
    if (!response.ok) { const errText = await response.text(); console.error(`[ai_task] Embedding API error (${response.status}):`, errText.slice(0, 200)); return null; }
    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (err) { console.error("[ai_task] Failed to generate query embedding:", err); return null; }
}

async function getSemanticKnowledgeChunks(
  queryText: string, supabaseUrl: string, supabaseServiceKey: string, userId: string, leadId?: string, contentTypes?: string[]
): Promise<KBChunksGrouped | null> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) { console.log("[ai_task] No OPENAI_API_KEY — falling back to text search"); return null; }
  const queryEmbedding = await generateQueryEmbedding(queryText, openaiKey);
  if (!queryEmbedding) { console.warn("[ai_task] Failed to generate query embedding — falling back to text search"); return null; }
  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const fetchCount = contentTypes ? Math.max(contentTypes.length * 3, 10) : MAX_KB_CHUNKS;
    const { data: matches, error } = await supabaseAdmin.rpc("match_knowledge_chunks_v2", {
      query_embedding: JSON.stringify(queryEmbedding), p_owner_user_id: userId, match_threshold: 0.4,
      match_count: fetchCount, filter_customer_facing: true, filter_lead_id: leadId || null, filter_content_types: contentTypes || null,
    });
    if (error) { console.error("[ai_task] Semantic search failed:", error); return null; }
    if (!matches || matches.length === 0) { console.log("[ai_task] No semantic matches found"); return null; }
    const grouped: KBChunksGrouped = {};
    let count = 0;
    for (const m of matches) {
      const ct = m.content_type || "knowledge";
      if (grouped[ct]) continue;
      grouped[ct] = `${m.title ? `[${m.title}] ` : ""}${m.content}`;
      count++;
      if (count >= MAX_KB_CHUNKS) break;
    }
    console.log(`[ai_task] Semantic: ${matches.length} raw → ${count} grouped (${Object.keys(grouped).join(",")}), top sim: ${matches[0]?.similarity?.toFixed(3)}`);
    return grouped;
  } catch (err) { console.error("[ai_task] Error in semantic search:", err); return null; }
}

async function getTextBasedKnowledgeChunks(
  queryText: string, supabaseUrl: string, supabaseServiceKey: string, userId: string, leadId?: string
): Promise<KBChunksGrouped | null> {
  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    let query = supabaseAdmin.from("kb_chunks").select("id, title, content, source, content_type")
      .eq("owner_user_id", userId).eq("allowed_customer_facing", true).eq("processing_status", "completed").limit(10);
    if (leadId) query = query.or(`lead_id.eq.${leadId},lead_id.is.null`);
    const keyTerms = queryText.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(term => term.length > 4).slice(0, 5);
    if (keyTerms.length > 0) query = query.or(keyTerms.map(term => `content.ilike.%${term}%`).join(','));
    const { data: matches, error } = await query;
    if (error) { console.error("[ai_task] Text search failed:", error); return null; }
    if (!matches || matches.length === 0) { console.log("[ai_task] No text matches found"); return null; }
    const grouped: KBChunksGrouped = {};
    let count = 0;
    for (const m of matches) {
      const ct = (m as any).content_type || "knowledge";
      if (grouped[ct]) continue;
      grouped[ct] = `${m.title ? `[${m.title}] ` : ""}${m.content}`;
      count++;
      if (count >= MAX_KB_CHUNKS) break;
    }
    console.log(`[ai_task] Text fallback: ${matches.length} raw → ${count} grouped (${Object.keys(grouped).join(",")})`);
    return grouped;
  } catch (err) { console.error("[ai_task] Error in text search:", err); return null; }
}

function formatKBContext(grouped: KBChunksGrouped, charLimit: number): string {
  const parts: string[] = [];
  let totalLen = 0;
  for (const [contentType, content] of Object.entries(grouped)) {
    const label = contentType.toUpperCase();
    const entry = `[${label}]\n${content}`;
    if (totalLen + entry.length > charLimit) {
      const remaining = charLimit - totalLen;
      if (remaining > 50) parts.push(`[${label}]\n${content.slice(0, remaining - label.length - 4)}…`);
      break;
    }
    parts.push(entry);
    totalLen += entry.length;
  }
  return parts.join("\n\n---\n\n");
}

async function getKnowledgeContext(
  queryText: string, supabaseUrl: string, supabaseServiceKey: string, userId: string, leadId?: string, task?: string
): Promise<{ formatted: string; grouped: KBChunksGrouped }> {
  const contentTypes = task ? TASK_KB_CONFIG[task] || undefined : undefined;
  const charLimit = task ? getKbCharLimit(task) : KB_CHAR_LIMIT_OUTBOUND;
  if (contentTypes) console.log(`[ai_task] Task "${task}" → KB types: [${contentTypes.join(", ")}], limit: ${charLimit} chars`);
  let grouped = await getSemanticKnowledgeChunks(queryText, supabaseUrl, supabaseServiceKey, userId, leadId, contentTypes);
  if (!grouped) {
    console.log("[ai_task] Falling back to text-based KB search");
    grouped = await getTextBasedKnowledgeChunks(queryText, supabaseUrl, supabaseServiceKey, userId, leadId);
  }
  if (!grouped || Object.keys(grouped).length === 0) return { formatted: "", grouped: {} };
  return { formatted: formatKBContext(grouped, charLimit), grouped };
}

// ============================================
// CORS & UTILS
// ============================================

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
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

const QUALITY_THRESHOLD = 24;

interface EmailQualityScore {
  curiosity: number;
  human_tone: number;
  spam_risk: number;
  reply_likelihood: number;
  summary: string;
}

const QUALITY_SCORED_TASKS = new Set([
  "pre_email_1_intro", "pre_email_2_followup", "pre_email_3_followup", "pre_email_4_breakup",
  "email_intro_fast", "email_intro_nurture", "re_engagement_intro",
]);

const PRO_MODEL_TASKS = [
  "post_meeting_recap", "extract_milestones_risks", "extract_deal_factors",
  "recommend_next_steps", "lead_deep_analysis", "post_meeting_followup_personalized",
];

const LITE_MODEL_TASKS = ["intent_router", "analyze_outgoing_email"];

function replaceTemplateVars(template: string, payload: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(payload)) {
    const placeholder = `{{${key.toUpperCase()}}}`;
    const replacement = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    result = result.split(placeholder).join(replacement);
  }
  result = result.replace(/\{\{[A-Z_]+\}\}/g, "");
  return result;
}

// ============================================
// MAIN HANDLER
// ============================================

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const token = authHeader.replace("Bearer ", "");
    const isServiceRole = token === supabaseServiceKey;
    
    let user: { id: string } | null = null;
    
    if (isServiceRole) {
      user = { id: "service-role" };
    } else {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
      if (authError || !authUser) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = authUser;
    }

    const { task, payload } = await req.json();

    if (!task || typeof task !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing or invalid task" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const taskPrompt = PROMPTS[task];
    if (!taskPrompt) {
      return new Response(JSON.stringify({ ok: false, error: `Unknown task: ${task}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY is not configured");
      return new Response(JSON.stringify({ ok: false, error: "AI gateway not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const DEFAULT_CADENCE_SETTINGS = {
      version: 1,
      modes: {
        fast: { reply_pending_hours: 4, outbound_followups_days: [2, 3, 3, 4], breakup_trigger: { days_since_first_outbound: 10, days_since_last_outbound: 5 }, post_meeting: { recap_suggest_after_hours: 4, checkins_days: [3, 7] } },
        nurture: { reply_pending_hours: 24, outbound_followups_days: [5, 7, 7, 10], breakup_trigger: { days_since_first_outbound: 30, days_since_last_outbound: 14 }, post_meeting: { recap_suggest_after_hours: 24, checkins_days: [7, 14, 30] } },
      },
      flows: { nurture_campaigns: { enabled: true, cadences_days: { weekly: 7, biweekly: 14, monthly: 30 }, min_days_after_last_touch: 7 } },
    };

    let enhancedPayload = { ...payload };
    let knowledgeContextUsed = false;

    let cadenceSettings = DEFAULT_CADENCE_SETTINGS;
    let cadencePromise: Promise<void> = Promise.resolve();
    if (payload?.lead_id) {
      cadencePromise = (async () => {
        try {
          const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data: combined } = await adminClient.from("leads")
            .select("owner_user_id, workspace_profiles!inner(cadence_settings)")
            .eq("id", payload.lead_id).maybeSingle();
          const wsCadence = (combined as any)?.workspace_profiles?.cadence_settings;
          if (wsCadence) {
            cadenceSettings = { ...DEFAULT_CADENCE_SETTINGS, ...wsCadence, modes: {
              fast: { ...DEFAULT_CADENCE_SETTINGS.modes.fast, ...wsCadence?.modes?.fast },
              nurture: { ...DEFAULT_CADENCE_SETTINGS.modes.nurture, ...wsCadence?.modes?.nurture },
            }};
            console.log(`[ai_task] Loaded workspace cadence settings (joined)`);
          }
        } catch (err) { console.error("[ai_task] Failed to load cadence settings, using defaults:", err); }
      })();
    }

    if (task === "followup_sequence_4") {
      const mode = (payload?.mode || "fast") as "fast" | "nurture";
      const cadenceDays = cadenceSettings.modes[mode]?.outbound_followups_days || [2, 3, 3, 4];
      enhancedPayload.cadence_days = JSON.stringify(cadenceDays);
      console.log(`[ai_task] Injected cadence_days for ${mode} mode: ${JSON.stringify(cadenceDays)}`);
    }
    
    const motion = String(enhancedPayload.motion || "");
    const isFirstTouch = enhancedPayload.first_touch === true;
    const isOutboundFirstTouch = motion === "outbound_prospecting" && isFirstTouch;

    let contextCachePromise: Promise<Record<string, unknown> | null> = Promise.resolve(null);
    if (payload?.lead_id) {
      contextCachePromise = (async () => {
        try {
          const cacheClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data } = await cacheClient.from("lead_context_cache")
            .select("context_json, last_generated_at").eq("lead_id", payload.lead_id).maybeSingle();
          if (data) {
            const age = Date.now() - new Date(data.last_generated_at).getTime();
            if (age < 6 * 60 * 60 * 1000) {
              console.log(`[ai_task] ✅ Context cache hit for lead ${payload.lead_id}, age: ${Math.round(age / 60000)}min`);
              return data.context_json as Record<string, unknown>;
            }
            console.log(`[ai_task] Context cache expired for lead ${payload.lead_id}`);
          }
          return null;
        } catch (err) { console.error("[ai_task] Context cache lookup failed:", err); return null; }
      })();
    }

    let signalsPromise: Promise<{ type: string; description: string; source: string }[]> = Promise.resolve([]);
    if (payload?.lead_id) {
      signalsPromise = (async () => {
        try {
          const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data } = await adminClient.from("lead_signals")
            .select("signal_type, signal_description, source_url")
            .eq("lead_id", payload.lead_id).order("detected_at", { ascending: false }).limit(8);
          return (data || []).map((s: any) => ({ type: s.signal_type, description: s.signal_description, source: s.source_url || "" }));
        } catch (err) { console.error("[ai_task] Failed to load lead_signals:", err); return []; }
      })();
    }

    let kbSearchPromise: Promise<{ formatted: string; grouped: KBChunksGrouped }> = Promise.resolve({ formatted: "", grouped: {} });
    if (KNOWLEDGE_SEARCH_TASKS.includes(task)) {
      const queryParts: string[] = [];
      if (payload?.email_text) queryParts.push(String(payload.email_text));
      if (payload?.questions_list) queryParts.push(String(payload.questions_list));
      if (payload?.lead_context) queryParts.push(String(payload.lead_context).slice(0, 500));
      if (payload?.meeting_summary) queryParts.push(String(payload.meeting_summary).slice(0, 500));
      const searchQuery = queryParts.join("\n").slice(0, 2000);
      if (searchQuery.length > 50) {
        const leadId = payload?.lead_id ? String(payload.lead_id) : undefined;
        console.log(`[ai_task] Searching knowledge base. Query length: ${searchQuery.length}, lead_id: ${leadId || 'global'}`);
        kbSearchPromise = getKnowledgeContext(searchQuery, supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, user.id, leadId, task);
      }
    }

    let diversityPromise: Promise<DiversityConstraints> = Promise.resolve({
      avoid_opening_types: [], avoid_angles: [], avoid_cta_types: [], preferred_angles: [], preferred_cta_types: [],
    });
    let resolvedWorkspaceId: string | null = null;
    if (payload?.lead_id && OUTREACH_TASKS.has(task)) {
      diversityPromise = (async () => {
        try {
          const divClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          const { data: membership } = await divClient.from("workspace_members")
            .select("workspace_id").eq("user_id", isServiceRole ? "service-role" : user.id).limit(1).maybeSingle();
          resolvedWorkspaceId = membership?.workspace_id || null;
          return buildDiversityConstraints(divClient, String(payload.lead_id), resolvedWorkspaceId, payload?.campaign_id ? String(payload.campaign_id) : null);
        } catch (err) { console.error("[ai_task] Diversity fetch failed:", err); return { avoid_opening_types: [], avoid_angles: [], avoid_cta_types: [], preferred_angles: [], preferred_cta_types: [] }; }
      })();
    }

    const [kbResult, , leadSignals, cachedContext, diversityConstraints] = await Promise.all([
      kbSearchPromise, cadencePromise, signalsPromise, contextCachePromise, diversityPromise,
    ]);

    if (cachedContext) {
      if (Array.isArray(cachedContext.recommended_angles) && (cachedContext.recommended_angles as string[]).length > 0) {
        enhancedPayload.recommended_angles = `Recommended outreach angles:\n- ${(cachedContext.recommended_angles as string[]).join("\n- ")}`;
      }
      if (cachedContext.company_summary) enhancedPayload.company_intelligence = String(cachedContext.company_summary);
      if (cachedContext.previous_interactions_summary) enhancedPayload.interaction_summary = String(cachedContext.previous_interactions_summary);
      if (cachedContext.industry_context && String(cachedContext.industry_context) !== "No industry-specific context available.") {
        enhancedPayload.industry_intelligence = String(cachedContext.industry_context);
      }
      if (leadSignals.length === 0 && Array.isArray(cachedContext.signals) && (cachedContext.signals as any[]).length > 0) {
        enhancedPayload.signals = JSON.stringify(cachedContext.signals);
        console.log(`[ai_task] ✅ Injected ${(cachedContext.signals as any[]).length} signals from context cache`);
      }
    }

    if (leadSignals.length > 0) {
      enhancedPayload.signals = JSON.stringify(leadSignals);
      console.log(`[ai_task] ✅ Injected ${leadSignals.length} lead signals into context`);
    }

    // === NEW: Build structured seller context from workspace_context for pre_email_1_intro ===
    const FIRST_TOUCH_TASKS = new Set(["pre_email_1_intro", "email_intro_fast", "re_engagement_intro"]);
    const isFirstTouchTask = FIRST_TOUCH_TASKS.has(task);

    if (isFirstTouchTask && isOutboundFirstTouch) {
      // Build SELLER_CONTEXT from workspace_context (product info, value props, use cases)
      const workspaceCtx = enhancedPayload.workspace_context ? String(enhancedPayload.workspace_context) : "";
      if (workspaceCtx) {
        enhancedPayload.seller_context = workspaceCtx;
        console.log(`[ai_task] ✅ Injected seller_context (${workspaceCtx.length} chars)`);
      } else {
        enhancedPayload.seller_context = "(No seller context available — use neutral observation approach)";
      }

      // Build LEAD_INTELLIGENCE from cached context (angles, company summary, signals)
      const intelligenceParts: string[] = [];
      if (enhancedPayload.company_intelligence) intelligenceParts.push(`Company: ${enhancedPayload.company_intelligence}`);
      if (enhancedPayload.recommended_angles) intelligenceParts.push(String(enhancedPayload.recommended_angles));
      if (enhancedPayload.industry_intelligence) intelligenceParts.push(`Industry Intel: ${enhancedPayload.industry_intelligence}`);
      enhancedPayload.lead_intelligence = intelligenceParts.length > 0
        ? intelligenceParts.join("\n")
        : "(No lead intelligence available — use neutral observation based on lead name/company/role only)";
      console.log(`[ai_task] ✅ Lead intelligence: ${intelligenceParts.length} sections`);

      // For first-touch: KB should be labeled as seller knowledge, not lead evidence
      if (kbResult.formatted) {
        const capped = kbResult.formatted.slice(0, 600);
        // Wrap KB in explicit seller label so prompt knows not to use as lead evidence
        enhancedPayload.knowledge_context = `(SELLER KNOWLEDGE — use ONLY to pick outreach angle, NOT as evidence about the lead)\n${capped}`;
        knowledgeContextUsed = true;
        console.log(`[ai_task] ✅ KB context labeled as SELLER KNOWLEDGE for first touch: ${capped.length} chars`);
      }
    } else {
      // Non-first-touch: standard KB injection
      if (kbResult.formatted) {
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
    }

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

    const taskBody = replaceTemplateVars(taskPrompt, enhancedPayload);

    const isOutboundMotion = motion === "outbound_prospecting";
    const outboundStyle = String(enhancedPayload.outbound_style || "standard");
    const isFollowUp = task === "pre_email_2_followup" || task === "pre_email_3_followup" || task === "pre_email_4_breakup";
    const isBreakup = task === "pre_email_4_breakup";

    const motionBlock = buildMotionBlock({ motion, first_touch: isFirstTouch });

    const styleParts: string[] = [];
    const styleBlock = buildStyleModifier({ motion, first_touch: isFirstTouch, outbound_style: outboundStyle });
    if (styleBlock) styleParts.push(styleBlock);
    if (isFirstTouch && isOutboundMotion && !hasInbound) styleParts.push(getColdOutreachBlock(playbookId));
    if (isFollowUp && isOutboundMotion) styleParts.push(REPLY_PATTERNS_BLOCK);
    if (isBreakup) styleParts.push(BREAKUP_CLOSERS[playbookId] || BREAKUP_CLOSERS.general_sales);
    const styleModifier = styleParts.join("\n\n") || "";

    const playbookContext = enhancedPayload.playbook_context ? String(enhancedPayload.playbook_context) : "";

    const hasDiversityConstraints = OUTREACH_TASKS.has(task) && (
      diversityConstraints.avoid_opening_types.length > 0 ||
      diversityConstraints.avoid_angles.length > 0 ||
      diversityConstraints.avoid_cta_types.length > 0
    );
    const diversityBlock = hasDiversityConstraints ? formatDiversityBlock(diversityConstraints) : "";
    if (diversityBlock) console.log("[ai_task] [4/DIVERSITY] Constraints injected");

    const resolvedChannel = resolveChannel(task, payload?.channel ? String(payload.channel) : undefined);
    const sequenceStep = resolveSequenceStep(task, payload?.sequence_step);
    
    let messagingFrameworkBlock = "";
    if (sequenceStep && !CHANNEL_FRAMEWORK_EXEMPT_TASKS.has(task)) {
      messagingFrameworkBlock = getSequenceFramework(resolvedChannel, sequenceStep);
    }
    if (!messagingFrameworkBlock) {
      messagingFrameworkBlock = getChannelFramework(task, resolvedChannel);
    }
    if (messagingFrameworkBlock) console.log(`[ai_task] [5/CHANNEL] ${resolvedChannel}${sequenceStep ? ` step=${sequenceStep}` : " (generic)"}`);

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

    const promptParts: string[] = [];
    if (motionBlock) promptParts.push(motionBlock);
    if (styleModifier) promptParts.push(styleModifier);
    if (messagingFrameworkBlock) promptParts.push(messagingFrameworkBlock);
    if (emailFrameworkBlock) promptParts.push(emailFrameworkBlock);
    if (diversityBlock) promptParts.push(diversityBlock);
    if (playbookContext) promptParts.push(playbookContext);
    promptParts.push(taskBody);
    const userPrompt = promptParts.join("\n\n");

    if (motionBlock) console.log(`[ai_task] [1/MOTION] ${motion}${isFirstTouch ? " (first_touch)" : ""}`);
    if (styleModifier) console.log(`[ai_task] [2/STYLE] ${styleParts.length} block(s)`);
    if (playbookContext) console.log("[ai_task] [3/PLAYBOOK] Playbook context");
    console.log(`[ai_task] Channel: ${resolvedChannel}, Step: ${sequenceStep ?? "none"}, Framework: ${selectedFramework ?? "none"}`);

    const clientModelHint = payload?.model_hint ? String(payload.model_hint) : null;
    const model = clientModelHint && ["google/gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"].includes(clientModelHint)
      ? clientModelHint
      : PRO_MODEL_TASKS.includes(task) ? "google/gemini-2.5-pro"
      : LITE_MODEL_TASKS.includes(task) ? "google/gemini-2.5-flash-lite"
      : "google/gemini-2.5-flash";

    console.log(`[ai_task] Task: ${task}, Model: ${model}, User: ${user.id}`);

    const streamRequested = payload?.stream === true;

    const aiRequestBody: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: `${SYSTEM_GLOBAL_PROMPT}\n\nCurrent date: ${new Date().toISOString().split('T')[0]}` },
        { role: "user", content: userPrompt },
      ],
    };

    if (streamRequested) aiRequestBody.stream = true;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(aiRequestBody),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded. Please try again later." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ ok: false, error: "Payment required. Please add credits to continue." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error(`[ai_task] AI gateway error (${response.status}):`, errorText.slice(0, 300));
      return new Response(JSON.stringify({ ok: false, error: `AI gateway returned ${response.status}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (streamRequested) {
      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    const aiResult = await response.json();
    let content = aiResult.choices?.[0]?.message?.content || "";
    
    // Strip any leaked internal reasoning from the output
    content = content.replace(/^(?:INTERNAL\s+REASONING|INTERNAL\s+REFLECTION|INTERNAL\s+ANALYSIS)[:\s]*[\s\S]*?(?=(?:^(?:Hi|Hey|Hello|Dear|Subject:|Thanks)\b|\n(?:Hi|Hey|Hello|Dear|Subject:|Thanks)\b))/im, "").trim();
    // Also strip if reasoning appears as a block before the actual email
    const reasoningBlockMatch = content.match(/^[\s\S]*?(?:(?:KB Insight|Constraint Check|Final plan|Let me|Okay,|Let's)[^\n]*\n)+[\s\S]*?\n\n((?:Hi|Hey|Hello|Dear|Subject:|Thanks)\b[\s\S]*)/im);
    if (reasoningBlockMatch) content = reasoningBlockMatch[1].trim();

    if (!content) {
      console.error("[ai_task] Empty response from AI gateway");
      return new Response(JSON.stringify({ ok: false, error: "AI returned empty response" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Quality scoring for outbound emails
    let qualityScore: EmailQualityScore | null = null;
    let regenerated = false;

    if (QUALITY_SCORED_TASKS.has(task)) {
      try {
        // Run quality score and grounding validation in parallel
        const [scoreResponse, groundingResponse] = await Promise.all([
          fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: QUALITY_SCORER_PROMPT },
                { role: "user", content: content },
              ],
            }),
          }),
          // Grounding validation for first-touch outbound
          isFirstTouchTask && isOutboundFirstTouch
            ? fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: GROUNDING_VALIDATOR_PROMPT },
                    { role: "user", content: `Generated Email:\n${content}\n\nLead Context:\n${enhancedPayload.lead_context || ""}\n\nSeller Context:\n${enhancedPayload.seller_context || enhancedPayload.workspace_context || ""}\n\nSignals:\n${enhancedPayload.signals || "None"}` },
                  ],
                }),
              })
            : Promise.resolve(null),
        ]);

        // Process grounding validation
        let groundingFailed = false;
        if (groundingResponse && groundingResponse.ok) {
          try {
            const groundingResult = await groundingResponse.json();
            const groundingText = groundingResult.choices?.[0]?.message?.content || "";
            const groundingMatch = groundingText.match(/\{[\s\S]*\}/);
            if (groundingMatch) {
              const grounding = JSON.parse(groundingMatch[0]);
              if (grounding.pass === false || grounding.safe_to_send === false) {
                groundingFailed = true;
                console.log(`[ai_task] ⚠️ GROUNDING VIOLATION detected: ${JSON.stringify(grounding.violations?.slice(0, 2))}`);
              } else {
                console.log(`[ai_task] ✅ Grounding validation passed`);
              }
            }
          } catch (gErr) { console.error("[ai_task] Grounding parse failed:", gErr); }
        }

        if (scoreResponse.ok) {
          const scoreResult = await scoreResponse.json();
          const scoreText = scoreResult.choices?.[0]?.message?.content || "";
          const jsonMatch = scoreText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            qualityScore = JSON.parse(jsonMatch[0]);
            const total = (qualityScore!.curiosity || 0) + (qualityScore!.human_tone || 0) + (qualityScore!.spam_risk || 0) + (qualityScore!.reply_likelihood || 0);
            const hasGroundingViolation = (qualityScore as any)?.grounding_violation === true;
            console.log(`[ai_task] Quality score: ${total}/40 (C:${qualityScore!.curiosity} H:${qualityScore!.human_tone} S:${qualityScore!.spam_risk} R:${qualityScore!.reply_likelihood})${hasGroundingViolation ? " [GROUNDING VIOLATION]" : ""}`);

            // Trigger regeneration if quality is low OR grounding failed
            const needsRegen = total < QUALITY_THRESHOLD || groundingFailed || hasGroundingViolation;
            if (needsRegen) {
              const reason = groundingFailed || hasGroundingViolation ? "grounding violation" : `low score (${total})`;
              console.log(`[ai_task] Regenerating: ${reason}. Using neutral_observation framework...`);
              const regenPromptParts = [...promptParts];
              const safeBlock = getEmailFrameworkBlock("neutral_observation");
              if (emailFrameworkBlock) {
                const idx = regenPromptParts.indexOf(emailFrameworkBlock);
                if (idx >= 0) regenPromptParts[idx] = safeBlock;
                else regenPromptParts.splice(regenPromptParts.length - 1, 0, safeBlock);
              } else {
                regenPromptParts.splice(regenPromptParts.length - 1, 0, safeBlock);
              }
              // Add explicit anti-hallucination instruction for regen
              regenPromptParts.splice(regenPromptParts.length - 1, 0, 
                "=== REGENERATION INSTRUCTION ===\nThe previous attempt failed grounding validation. Write a SAFER email:\n- Use ONLY facts from Lead Context (Section B)\n- Ask a neutral question about their role or company\n- Do NOT reference seller products or assume pain points\n- If unsure, keep it ultra-short: one observation + one question"
              );

              const regenResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model,
                  messages: [
                    { role: "system", content: `${SYSTEM_GLOBAL_PROMPT}\n\nCurrent date: ${new Date().toISOString().split('T')[0]}` },
                    { role: "user", content: regenPromptParts.join("\n\n") },
                  ],
                }),
              });

              if (regenResponse.ok) {
                const regenResult = await regenResponse.json();
                const regenContent = regenResult.choices?.[0]?.message?.content || "";
                if (regenContent) {
                  regenerated = true;
                  selectedFramework = "neutral_observation" as any;
                  // Re-score
                  const rescore = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                    method: "POST",
                    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "system", content: QUALITY_SCORER_PROMPT }, { role: "user", content: regenContent }] }),
                  });
                  if (rescore.ok) {
                    const rescoreResult = await rescore.json();
                    const rescoreText = rescoreResult.choices?.[0]?.message?.content || "";
                    const rescoreMatch = rescoreText.match(/\{[\s\S]*\}/);
                    if (rescoreMatch) qualityScore = JSON.parse(rescoreMatch[0]);
                  }

                  // Log diversity for regenerated content
                  if (resolvedWorkspaceId && OUTREACH_TASKS.has(task)) {
                    try {
                      const classifyResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                        method: "POST",
                        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: CLASSIFY_MESSAGE_PROMPT + regenContent }] }),
                      });
                      if (classifyResponse.ok) {
                        const classifyResult = await classifyResponse.json();
                        const classifyText = classifyResult.choices?.[0]?.message?.content || "";
                        const classifyMatch = classifyText.match(/\{[\s\S]*\}/);
                        if (classifyMatch) {
                          const classification = JSON.parse(classifyMatch[0]);
                          const logClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
                          await logClient.from("message_generation_log").insert({
                            workspace_id: resolvedWorkspaceId, lead_id: String(payload.lead_id),
                            campaign_id: payload?.campaign_id ? String(payload.campaign_id) : null,
                            task_type: task, channel: resolvedChannel, sequence_step: sequenceStep,
                            generated_message: regenContent.slice(0, 2000),
                            opening_type: classification.opening_type || "question",
                            primary_angle: classification.primary_angle || "general",
                            secondary_angle: classification.secondary_angle || null,
                            cta_type: classification.cta_type || "quick_question",
                            tone: classification.tone || "professional",
                          });
                        }
                      }
                    } catch (logErr) { console.error("[ai_task] Diversity log failed:", logErr); }
                  }

                  const responsePayload: Record<string, unknown> = {
                    ok: true, content: regenContent,
                    quality_score: qualityScore, regenerated: true, framework_used: selectedFramework,
                  };
                  return new Response(JSON.stringify(responsePayload), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                }
              }
            }
          }
        }
      } catch (scoreErr) {
        console.error("[ai_task] Quality scoring failed:", scoreErr);
      }
    }

    // Log message diversity (non-regenerated path)
    if (resolvedWorkspaceId && OUTREACH_TASKS.has(task) && payload?.lead_id) {
      try {
        const classifyResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: CLASSIFY_MESSAGE_PROMPT + content }] }),
        });
        if (classifyResponse.ok) {
          const classifyResult = await classifyResponse.json();
          const classifyText = classifyResult.choices?.[0]?.message?.content || "";
          const classifyMatch = classifyText.match(/\{[\s\S]*\}/);
          if (classifyMatch) {
            const classification = JSON.parse(classifyMatch[0]);
            const logClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
            await logClient.from("message_generation_log").insert({
              workspace_id: resolvedWorkspaceId, lead_id: String(payload.lead_id),
              campaign_id: payload?.campaign_id ? String(payload.campaign_id) : null,
              task_type: task, channel: resolvedChannel, sequence_step: sequenceStep,
              generated_message: content.slice(0, 2000),
              opening_type: classification.opening_type || "question",
              primary_angle: classification.primary_angle || "general",
              secondary_angle: classification.secondary_angle || null,
              cta_type: classification.cta_type || "quick_question",
              tone: classification.tone || "professional",
            });
            console.log(`[ai_task] ✅ Logged diversity: ${classification.opening_type}/${classification.primary_angle}/${classification.cta_type}`);
          }
        }
      } catch (logErr) { console.error("[ai_task] Diversity log failed:", logErr); }
    }

    const responsePayload: Record<string, unknown> = { ok: true, content };
    if (qualityScore) responsePayload.quality_score = qualityScore;
    if (regenerated) responsePayload.regenerated = true;
    if (selectedFramework) responsePayload.framework_used = selectedFramework;

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
