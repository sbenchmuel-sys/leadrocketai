// ============================================================
// extract-lead-profile — AI profile extraction for a single lead
//
// Reads the lead's email thread (canonical timeline + legacy
// interactions, with ai_summary fallback once raw bodies purge),
// asks the AI to extract the prospect's real name, company, job
// title, and a few durable context notes, then fills ONLY empty /
// email-derived lead fields and inserts lead_context_items.
//
// Retention-safe: extracts INTO durable profile fields — never
// re-stores raw message bodies. The display name lives in
// from_email (retained metadata), so the name fix survives purge.
//
// Workspace isolation: the lead is fetched with the CALLER's JWT
// (RLS enforces membership); if they can't see it, we abort.
// Writes use the service role only after that check passes.
//
// Invoked on-demand (manual "Enrich from email" / post-promotion).
// Auth: user JWT (verify_jwt = true).
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// A name that is really just the email address, or the formatted
// local-part guess (e.g. "Rfrankel" from rfrankel@…), is NOT a real
// display name — those are safe to replace with an extracted one.
function looksEmailDerived(name: string | null | undefined, email: string): boolean {
  if (!name || !name.trim()) return true;
  const n = name.trim().toLowerCase();
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (n === email.toLowerCase()) return true;
  if (n === local) return true;
  // formatted local-part: "rfrankel" -> "Rfrankel", "ryan.frankel" -> "Ryan Frankel"
  const formattedLocal = local.replace(/[._-]+/g, " ").trim();
  return n === formattedLocal;
}

serve(async (req) => {
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

    // Caller-scoped client — RLS enforces workspace membership on the lead read.
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { lead_id } = await req.json();
    if (!lead_id) {
      return new Response(JSON.stringify({ ok: false, error: "Missing lead_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Membership gate: fetch the lead through the caller's JWT. If RLS hides it,
    // the caller is not a member of its workspace — abort before any service-role work.
    const { data: lead, error: leadErr } = await userClient
      .from("leads")
      .select("id, workspace_id, name, company, job_title, email")
      .eq("id", lead_id)
      .maybeSingle();
    if (leadErr || !lead) {
      return new Response(JSON.stringify({ ok: false, error: "Lead not found or access denied" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // ── Build the thread context (provider-agnostic) ──
    // Prefer canonical timeline; fall back to legacy interactions. from_email
    // (retained metadata) carries the display name; body falls back to ai_summary.
    const { data: rows } = await admin
      .from("interactions")
      .select("type, direction, subject, from_email, body_text, ai_summary, occurred_at")
      .eq("lead_id", lead_id)
      .in("type", ["email_inbound", "email_outbound"])
      .order("occurred_at", { ascending: true })
      .limit(20);

    const threadLines: string[] = [];
    const inboundFromHeaders: string[] = [];
    for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
      // Prefer the direction column; fall back to the type suffix if it's unset.
      const isInbound =
        (r.direction as string) === "inbound" ||
        (!(r.direction) && (r.type as string) === "email_inbound");
      const dir = isInbound ? "FROM PROSPECT" : "FROM REP";
      const from = (r.from_email as string) || "";
      if (isInbound && from) inboundFromHeaders.push(from);
      const body = ((r.body_text as string) || (r.ai_summary as string) || "").slice(0, 1500);
      threadLines.push(`[${dir}] From: ${from}\nSubject: ${(r.subject as string) || ""}\n${body}`);
    }

    if (threadLines.length === 0) {
      return new Response(JSON.stringify({ ok: true, extracted: null, reason: "No email thread to extract from" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const threadContext = threadLines.join("\n===\n").slice(0, 9000);
    const fromHeaderHints = [...new Set(inboundFromHeaders)].join("; ").slice(0, 500);

    // ── AI extraction ──
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ ok: false, error: "AI gateway not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const prompt = `TASK: Extract the PROSPECT's profile from this email thread. The prospect is the person labelled "FROM PROSPECT" (their email: ${lead.email}). Ignore the rep's own details.

RULES:
- Only set a field if you are at least 70% confident; otherwise null.
- Each field carries a "confidence" (0.0-1.0). Below 0.7 → value must be null.
- "name": the prospect's real full name. The From header is the best source — prefer the display name there (e.g. "Ryan Frankel <r@co.com>" → "Ryan Frankel"). Do NOT invent a name from the email address.
- "company": the prospect's company (from signature, domain context, or what they say). Not the rep's company.
- "job_title": the prospect's role, if stated or in a signature.
- "context_notes": 1-3 SHORT durable facts useful for future outreach — e.g. a competitor they currently use, who referred them, a stated priority or pain, an expansion/timing signal. Each note: {"category": one of ["relationship_history","commercial_signal","caution","historical_fact"], "text": "<= 200 chars", "confidence": 0.0}. Omit if nothing concrete.

Prospect From headers seen in the thread (best source for the real name):
${fromHeaderHints || "(none)"}

THREAD:
${threadContext}

Return ONLY this JSON (no markdown):
{
  "name": {"value": "string|null", "confidence": 0.0},
  "company": {"value": "string|null", "confidence": 0.0},
  "job_title": {"value": "string|null", "confidence": 0.0},
  "context_notes": [{"category": "string", "text": "string", "confidence": 0.0}]
}`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are a data extraction assistant. Return valid JSON only, no markdown fences." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("[extract-lead-profile] AI gateway error:", errText.slice(0, 300));
      return new Response(JSON.stringify({ ok: false, error: "AI extraction failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "{}";
    let extracted: {
      name?: { value: string | null; confidence: number };
      company?: { value: string | null; confidence: number };
      job_title?: { value: string | null; confidence: number };
      context_notes?: Array<{ category: string; text: string; confidence: number }>;
    };
    try {
      const cleaned = rawContent.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      extracted = JSON.parse(cleaned);
    } catch {
      console.error("[extract-lead-profile] Failed to parse AI response:", rawContent.slice(0, 300));
      return new Response(JSON.stringify({ ok: false, error: "Failed to parse AI response" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Apply: fill ONLY empty / email-derived fields. Never overwrite a real value. ──
    const CONF = 0.7;
    const updates: Record<string, unknown> = {};

    const nm = extracted.name;
    if (nm?.value && nm.confidence >= CONF && looksEmailDerived(lead.name as string, lead.email as string)) {
      updates.name = nm.value.trim();
    }
    const co = extracted.company;
    const currentCompany = ((lead.company as string) || "").trim().toLowerCase();
    const companyEmpty = !currentCompany || currentCompany === "unknown" || currentCompany === (lead.email as string).split("@")[1]?.toLowerCase();
    if (co?.value && co.confidence >= CONF && companyEmpty) {
      updates.company = co.value.trim();
    }
    const jt = extracted.job_title;
    if (jt?.value && jt.confidence >= CONF && !((lead.job_title as string) || "").trim()) {
      updates.job_title = jt.value.trim();
    }

    if (Object.keys(updates).length > 0) {
      await admin.from("leads").update(updates).eq("id", lead_id);
    }

    // ── Context notes → lead_context_items (dedupe against existing active text) ──
    const ALLOWED = new Set(["relationship_history", "commercial_signal", "caution", "historical_fact"]);
    const notes = (extracted.context_notes ?? []).filter(
      (n) => n && n.text && n.confidence >= CONF && ALLOWED.has(n.category),
    );
    let notesInserted = 0;
    if (notes.length > 0) {
      const { data: existing } = await admin
        .from("lead_context_items")
        .select("content_text")
        .eq("lead_id", lead_id)
        .eq("is_active", true);
      const seen = new Set((existing ?? []).map((e) => (e.content_text as string).trim().toLowerCase()));
      const toInsert = notes
        .filter((n) => !seen.has(n.text.trim().toLowerCase()))
        .map((n) => ({
          lead_id,
          workspace_id: lead.workspace_id,
          category: n.category,
          content_type: "general",
          content_text: n.text.trim().slice(0, 200),
          source_type: "ai_extraction",
          confidence: n.confidence,
          is_active: true,
        }));
      if (toInsert.length > 0) {
        const { error: insErr } = await admin.from("lead_context_items").insert(toInsert);
        if (insErr) console.warn("[extract-lead-profile] context insert failed:", insErr.message);
        else notesInserted = toInsert.length;
      }
    }

    console.log(`[extract-lead-profile] lead ${lead_id}: fields=${Object.keys(updates).join(",") || "none"}, notes=${notesInserted}`);

    return new Response(
      JSON.stringify({ ok: true, extracted, applied: { fields: updates, notes_inserted: notesInserted } }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[extract-lead-profile] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "An error occurred", error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
