import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { target } = await req.json(); // "workspace" | "rep_profile" | "signatures" | "all"

    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Gather KB chunks
    const { data: kbChunks } = await supabaseAdmin
      .from("kb_chunks")
      .select("content, title, source")
      .eq("processing_status", "completed")
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30);

    // Gather recent email interactions for signature extraction
    const { data: emailInteractions } = await supabaseAdmin
      .from("interactions")
      .select("body_text, subject, from_email, direction, source")
      .eq("direction", "outbound")
      .eq("type", "email")
      .order("occurred_at", { ascending: false })
      .limit(20);

    // Also check inbound emails to find the user's signature from replies
    const { data: inboundEmails } = await supabaseAdmin
      .from("interactions")
      .select("body_text, from_email, direction")
      .eq("direction", "inbound")
      .eq("type", "email")
      .order("occurred_at", { ascending: false })
      .limit(10);

    // Get existing workspace profile for context
    const { data: existingWsProfile } = await supabaseAdmin
      .from("workspace_profiles")
      .select("company_kb, industry_pack, company_name, product_name, product_description, primary_value_props")
      .eq("user_id", user.id)
      .maybeSingle();

    // Get existing rep profile
    const { data: existingRepProfile } = await supabaseAdmin
      .from("rep_profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    // Build context from all sources
    const kbContext = (kbChunks || []).map(c => c.content).join("\n---\n").slice(0, 8000);
    const outboundEmailContext = (emailInteractions || [])
      .map(e => `Subject: ${e.subject || ''}\nFrom: ${e.from_email || ''}\n${e.body_text}`)
      .join("\n===\n")
      .slice(0, 4000);
    
    const companyKb = existingWsProfile?.company_kb ? JSON.stringify(existingWsProfile.company_kb).slice(0, 3000) : "";
    const industryPack = existingWsProfile?.industry_pack ? JSON.stringify(existingWsProfile.industry_pack).slice(0, 2000) : "";

    // Build the AI prompt based on target
    const prompt = buildExtractionPrompt(target, kbContext, outboundEmailContext, companyKb, industryPack, existingRepProfile, existingWsProfile);

    // Call the Lovable AI gateway
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ ok: false, error: "AI gateway not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiResponse = await fetch("https://ai-gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
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
      console.error("[extract-profile-from-kb] AI gateway error:", errText);
      return new Response(JSON.stringify({ ok: false, error: "AI extraction failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "{}";
    
    // Parse JSON (handle markdown fences)
    let extracted: Record<string, unknown>;
    try {
      const cleaned = rawContent.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      extracted = JSON.parse(cleaned);
    } catch {
      console.error("[extract-profile-from-kb] Failed to parse AI response:", rawContent.slice(0, 500));
      return new Response(JSON.stringify({ ok: false, error: "Failed to parse AI response" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[extract-profile-from-kb] Extracted data:", JSON.stringify(extracted).slice(0, 500));

    return new Response(
      JSON.stringify({ ok: true, extracted }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[extract-profile-from-kb] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "An error occurred", error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function buildExtractionPrompt(
  target: string,
  kbContext: string,
  emailContext: string,
  companyKb: string,
  industryPack: string,
  existingRepProfile: Record<string, unknown> | null,
  existingWsProfile: Record<string, unknown> | null
): string {
  const parts: string[] = [];

  parts.push(`TASK: Extract profile information from the provided knowledge base documents and email history.
IMPORTANT: Only include a field if you are at least 80% confident in the extracted value. For uncertain fields, set them to null.
Each field must also include a "confidence" score (0.0-1.0). Only fields with confidence >= 0.8 should have non-null values.`);

  if (target === "all" || target === "workspace") {
    parts.push(`
WORKSPACE PROFILE EXTRACTION:
Extract the following company/product info:
{
  "workspace": {
    "company_name": {"value": "string|null", "confidence": 0.0},
    "product_name": {"value": "string|null", "confidence": 0.0},
    "product_description": {"value": "string|null", "confidence": 0.0},
    "primary_value_props": {"value": ["string"]|null, "confidence": 0.0},
    "meeting_timezone": {"value": "string|null", "confidence": 0.0}
  }
}
Existing workspace data (do NOT overwrite if already set):
${existingWsProfile ? `company_name: ${existingWsProfile.company_name || 'empty'}, product_name: ${existingWsProfile.product_name || 'empty'}, product_description: ${existingWsProfile.product_description || 'empty'}` : 'No existing profile'}`);
  }

  if (target === "all" || target === "rep_profile") {
    parts.push(`
REP PROFILE EXTRACTION:
Extract the sales representative's personal info from emails (signatures, from fields) and documents:
{
  "rep_profile": {
    "full_name": {"value": "string|null", "confidence": 0.0},
    "email": {"value": "string|null", "confidence": 0.0},
    "phone": {"value": "string|null", "confidence": 0.0},
    "job_title": {"value": "string|null", "confidence": 0.0},
    "company_name": {"value": "string|null", "confidence": 0.0},
    "linkedin_url": {"value": "string|null", "confidence": 0.0},
    "calendar_link": {"value": "string|null", "confidence": 0.0},
    "office_address": {"value": "string|null", "confidence": 0.0}
  }
}
Existing rep data (do NOT overwrite if already set):
${existingRepProfile ? `full_name: ${(existingRepProfile as any).full_name || 'empty'}, email: ${(existingRepProfile as any).email || 'empty'}, phone: ${(existingRepProfile as any).phone || 'empty'}, job_title: ${(existingRepProfile as any).job_title || 'empty'}` : 'No existing profile'}`);
  }

  if (target === "all" || target === "signatures") {
    parts.push(`
EMAIL SIGNATURE EXTRACTION:
Look for email signatures in the outbound emails. A signature typically appears at the end of emails and contains name, title, company, phone, links, etc.
Extract any distinct signatures found:
{
  "signatures": [
    {
      "name": "Signature label (e.g. 'Professional' or 'Primary')",
      "signature_text": "The full signature text as it appears",
      "confidence": 0.0
    }
  ]
}
Only include signatures with confidence >= 0.8. Deduplicate similar signatures.`);
  }

  parts.push(`
SOURCES:

Knowledge Base Documents:
${kbContext || '(no KB documents found)'}

Company Knowledge:
${companyKb || '(none)'}

Industry Pack:
${industryPack || '(none)'}

Outbound Emails (for rep profile & signature extraction):
${emailContext || '(no outbound emails found)'}

Return a single JSON object containing the requested sections. Only include sections that were requested.`);

  return parts.join("\n");
}
