import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Tasks that require semantic knowledge search
const KNOWLEDGE_SEARCH_TASKS = [
  "email_intro_fast",
  "email_intro_nurture",
  "followup_sequence_4",
  "post_meeting_recap",
  "answer_questions",
  "pre_email_1_intro",
  "pre_email_2_followup",
  "pre_email_3_followup",
  "pre_email_4_breakup",
  "post_meeting_followup_personalized",
  "nurture_sequence",
  "nurture_email_single",
  "post_meeting_followup_email",
  "extract_milestones_risks",
  "extract_deal_factors",
  "recommend_next_steps",
  "linkedin_followup",
];

// Function to get semantic knowledge context with optional lead-scoping
async function getSemanticKnowledgeContext(
  queryText: string,
  supabaseUrl: string,
  supabaseServiceKey: string,
  lovableApiKey: string,
  leadId?: string
): Promise<string> {
  try {
    // Generate embedding for the query
    const embResponse = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/text-embedding-004",
        input: queryText.slice(0, 5000),
      }),
    });

    if (!embResponse.ok) {
      const errorText = await embResponse.text();
      console.error("[ai_task] Embedding generation failed:", embResponse.status, errorText);
      return "";
    }

    const embData = await embResponse.json();
    const queryEmbedding = embData.data?.[0]?.embedding;

    if (!queryEmbedding || !Array.isArray(queryEmbedding)) {
      console.log("[ai_task] Invalid embedding response");
      return "";
    }

    // Use service role to call the match function with lead-scoping
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    
    const { data: matches, error } = await supabaseAdmin.rpc("match_knowledge_chunks", {
      query_embedding: `[${queryEmbedding.join(",")}]`,
      match_threshold: 0.4,
      match_count: 5,
      filter_customer_facing: true,
      filter_lead_id: leadId || null,
    });

    if (error) {
      console.error("[ai_task] Semantic search failed:", error);
      return "";
    }

    if (!matches || matches.length === 0) {
      console.log("[ai_task] No semantic matches found");
      return "";
    }

    console.log(`[ai_task] Found ${matches.length} semantic matches${leadId ? ` for lead ${leadId}` : ""}`);

    // Format the matched chunks as context
    const context = matches
      .map((m: { title: string; content: string; similarity: number; source: string }) => {
        const header = m.title ? `[${m.title}]` : "";
        const score = `(relevance: ${(m.similarity * 100).toFixed(0)}%)`;
        return `${header} ${score}\n${m.content}`;
      })
      .join("\n\n---\n\n");

    return context;
  } catch (err) {
    console.error("[ai_task] Error in semantic search:", err);
    return "";
  }
}

// Dynamic CORS based on allowed origins
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  
  // In development, allow localhost origins; in production, allow Lovable project domains
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || allowedOrigins.includes("*");
  
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// System prompt
const SYSTEM_GLOBAL_PROMPT = `You are a regulated B2B Sales Deal Assistant. Your job is to help sales users manage long-cycle, regulated enterprise deals (healthcare, insurance, pharma, telemedicine).

HARD RULES
1) Nothing is ever auto-sent. You only create drafts and suggested actions.
2) Never invent facts. If unknown, ask for missing info or propose a safe next step.
3) No medical advice. No diagnosis/treatment claims. Do not claim clinical performance unless explicitly present in Knowledge Context.
4) No legal advice. For privacy/security questions, provide general best practices and point to official/security documentation if provided.
5) Customer-safe: do not share internal-only pricing/roadmap/confidential notes unless Knowledge Context explicitly marks it as allowed_customer_facing=true.
6) Concise writing: short paragraphs, 1 clear CTA per email, avoid jargon.
7) Personalize using lead/company/context. If missing, keep it generic and ask 1 clarifying question only when necessary.
8) If a task requires JSON, output JSON ONLY (no extra text). If output is an email body, output only the body text (no subject unless asked).
9) If you include "evidence", keep evidence snippets <= 200 characters.

STRATEGY MODES
- FAST: short-cycle, direct, book meeting ASAP, tighter cadence.
- NURTURE: long-cycle, value-led, patient cadence, credibility-building.

YOUR GOAL
Increase speed and consistency, surface risks early, and guide next steps while staying compliant.`;

// Task prompts
const PROMPTS: Record<string, string> = {
  intent_router: `You are classifying an inbound B2B email for a regulated enterprise sales process.

Return JSON ONLY in this exact schema:
{
  "intent_primary": "book_meeting|pricing|technical_sdk|security_privacy|legal_procurement|partnership|support|not_sure",
  "urgency": "high|medium|low",
  "reply_worthy": true,
  "suggested_strategy": "fast|nurture",
  "questions_extracted": ["..."],
  "tone": "positive|neutral|negative"
}

Rules:
- reply_worthy=true if the email requires a response from sales (questions, requests, objections, meeting scheduling).
- suggested_strategy=fast if urgency high OR explicit request for call/demo/pricing/procurement steps.
- Extract explicit questions verbatim into questions_extracted.
- If unclear, intent_primary="not_sure" and reply_worthy=true.

INPUT:
Lead Context:
{{LEAD_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}`,

  email_intro_fast: `Write a FAST intro email reply for a regulated B2B lead.
Goal: respond clearly, create confidence, and book a meeting soon.

Constraints:
- 120–180 words
- 1 clear CTA (book a 30-min call)
- If they asked questions, answer briefly and offer to cover deeper on call
- Do NOT mention anything not in Knowledge Context
- Return EMAIL BODY ONLY

Lead Context:
{{LEAD_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Meeting link (optional):
{{MEETING_LINK}}`,

  email_intro_nurture: `Write a NURTURE intro email reply for a regulated B2B lead.
Goal: be helpful, provide 1–2 value points, share 1 resource, invite a call without pressure.

Constraints:
- 140–220 words
- Helpful tone, credibility-building
- 1 soft CTA (offer a call / ask what's best next step)
- Use Knowledge Context only
- Return EMAIL BODY ONLY

Lead Context:
{{LEAD_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Optional resource to mention:
{{RESOURCE_LINK_OR_TITLE}}

Meeting link (optional):
{{MEETING_LINK}}`,

  followup_sequence_4: `Generate a 4-email follow-up sequence for a regulated B2B prospect.
Mode is either FAST or NURTURE.

Return JSON ONLY in this schema:
{
  "mode": "fast|nurture",
  "cadence_days": [3,4,4,5],
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

  answer_questions: `Write a customer-safe email answer to the prospect's question(s), grounded ONLY in the Knowledge Context.
If knowledge is insufficient, say what you can, then propose a call or offer to share the right document.

Return EMAIL BODY ONLY (no subject).

Lead Context:
{{LEAD_CONTEXT}}

Questions:
{{QUESTIONS_LIST}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Meeting link (optional):
{{MEETING_LINK}}`,

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

  // Pre-Meeting Email Cadence
  pre_email_1_intro: `ROLE
You are generating Email 1 (Intro) in a pre-meeting outreach cadence for a regulated B2B deal.

GOAL
Introduce the company clearly, personalize to the lead, and encourage booking the first meeting.

CONSTRAINTS
- 120–180 words
- Professional, confident, non-pushy
- One clear CTA (book a call)
- No medical or performance claims
- Use only approved Knowledge Context
- If information is missing, stay high-level

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

OUTPUT
Return EMAIL BODY ONLY.`,

  pre_email_2_followup: `ROLE
You are generating Email 2 in a pre-meeting outreach cadence.

GOAL
Politely follow up after no response, add one value point, and reduce friction to reply.

CONSTRAINTS
- 90–140 words
- Friendly, respectful of time
- Briefly reference previous email
- One clear CTA (book a call)
- No hype or guarantees

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Previous Outreach Summary:
{{PREVIOUS_EMAIL_SUMMARY}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

OUTPUT
Return EMAIL BODY ONLY.`,

  pre_email_3_followup: `ROLE
You are generating Email 3 in a pre-meeting outreach cadence.

GOAL
Check relevance, prompt a yes/no response, and keep tone professional.

CONSTRAINTS
- 70–120 words
- More direct, still polite
- Explicitly acknowledge silence without pressure
- One clear CTA (call, redirect, or deprioritize)

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Previous Outreach Summary:
{{PREVIOUS_EMAIL_SUMMARY}}

Meeting Link:
{{MEETING_LINK}}

OUTPUT
Return EMAIL BODY ONLY.`,

  pre_email_4_breakup: `ROLE
You are generating Email 4 (Breakup) in a pre-meeting outreach cadence.

GOAL
Close the loop respectfully and leave the door open.

CONSTRAINTS
- 50–90 words
- Calm, polite, non-defensive
- No CTA except soft invitation to reconnect
- No claims

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

OUTPUT
Return EMAIL BODY ONLY.`,

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

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

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

  // Utility: Shorten Draft
  shorten_draft: `ROLE
Shorten an existing draft while preserving meaning and CTA.

CONSTRAINTS
- Maintain the core message and CTA
- Remove filler words and redundant phrases
- Keep professional tone

INPUTS
Draft Text:
{{DRAFT_TEXT}}

Target Length:
{{TARGET}}

OUTPUT
Return shortened draft text only.`,

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

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

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
Generate a personalized post-meeting follow-up email using all available knowledge about this lead.

GOAL
Thank them for the meeting, summarize key points, and propose clear next steps.

CONSTRAINTS
- 120–200 words
- Professional and warm
- Reference specific topics discussed if meeting context is available
- Use knowledge context to add relevant details
- ONE clear CTA (e.g., confirm next meeting, review materials, connect on specific item)
- No medical or performance claims
- Return EMAIL BODY ONLY (no subject line, no JSON, no markdown)

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Meeting Summary (optional brief notes):
{{MEETING_SUMMARY_BRIEF}}

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
};

// Tasks that require the pro model
const PRO_MODEL_TASKS = [
  "post_meeting_recap",
  "extract_milestones_risks",
  "extract_deal_factors",
  "recommend_next_steps",
  "nurture_sequence",
  "nurture_email_single",
  "post_meeting_followup_email",
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
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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

    // Enhance payload with semantic knowledge search for relevant tasks
    let enhancedPayload = { ...payload };
    
    if (KNOWLEDGE_SEARCH_TASKS.includes(task)) {
      // Build a query from the available context
      const queryParts: string[] = [];
      if (payload?.email_text) queryParts.push(String(payload.email_text));
      if (payload?.questions_list) queryParts.push(String(payload.questions_list));
      if (payload?.lead_context) queryParts.push(String(payload.lead_context).slice(0, 500));
      if (payload?.meeting_summary) queryParts.push(String(payload.meeting_summary).slice(0, 500));
      
      const searchQuery = queryParts.join("\n").slice(0, 2000);
      
      if (searchQuery.length > 50) {
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        // Pass lead_id for lead-scoped knowledge if available
        const leadId = payload?.lead_id ? String(payload.lead_id) : undefined;
        const semanticContext = await getSemanticKnowledgeContext(
          searchQuery,
          supabaseUrl,
          supabaseServiceKey,
          LOVABLE_API_KEY,
          leadId
        );
        
        if (semanticContext) {
          enhancedPayload.knowledge_context = semanticContext;
          console.log(`[ai_task] Added semantic knowledge context (${semanticContext.length} chars)${leadId ? ` for lead ${leadId}` : ""}`);
        }
      }
    }

    // Build the user prompt with template variables replaced
    const userPrompt = replaceTemplateVars(taskPrompt, enhancedPayload);

    // Select model based on task
    const model = PRO_MODEL_TASKS.includes(task)
      ? "google/gemini-2.5-pro"
      : "google/gemini-2.5-flash";

    console.log(`[ai_task] Task: ${task}, Model: ${model}, User: ${user.id}`);

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_GLOBAL_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
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

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";

    console.log(`[ai_task] Success. Response length: ${content.length}`);

    return new Response(
      JSON.stringify({ ok: true, content, raw: data }),
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
