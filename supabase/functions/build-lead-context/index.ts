import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { assertLeadAccess, isInternalCaller } from "../_shared/authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Context structure ─────────────────────────────────────────────────
interface LeadContextJson {
  company_summary: string;
  lead_role_summary: string;
  signals: { type: string; description: string; source: string }[];
  recommended_angles: string[];
  industry_context: string;
  previous_interactions_summary: string;
  generated_at: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const isInternal = isInternalCaller(req);
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    let userId: string;
    if (isInternal) {
      userId = "internal";
    } else {
      const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error } = await anonClient.auth.getUser();
      if (error || !user) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = user.id;
    }

    const { lead_id, force } = await req.json();
    if (!lead_id) {
      return new Response(JSON.stringify({ ok: false, error: "Missing lead_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Authz: verify caller can access this lead (skip for internal callers)
    if (!isInternal) {
      const authzCheck = await assertLeadAccess(adminClient, lead_id, userId);
      if (!authzCheck.ok) {
        return new Response(JSON.stringify({ ok: false, error: authzCheck.error }), {
          status: authzCheck.status || 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Check existing cache (skip if force=true)
    if (!force) {
      const { data: existing } = await adminClient
        .from("lead_context_cache")
        .select("context_json, last_generated_at")
        .eq("lead_id", lead_id)
        .maybeSingle();

      if (existing) {
        const age = Date.now() - new Date(existing.last_generated_at).getTime();
        const MAX_AGE = 6 * 60 * 60 * 1000; // 6 hours
        if (age < MAX_AGE) {
          console.log(`[build-lead-context] Cache hit for ${lead_id}, age: ${Math.round(age / 60000)}min`);
          return new Response(JSON.stringify({ ok: true, context: existing.context_json, cached: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    console.log(`[build-lead-context] Building context for lead ${lead_id}`);

    // Step 1-4: Fetch all data in parallel
    const [leadResult, signalsResult, interactionsResult, enrichmentResult, kbResult] = await Promise.all([
      // 1. Lead profile
      adminClient.from("leads").select("*").eq("id", lead_id).maybeSingle(),
      // 2. Signals
      adminClient.from("lead_signals")
        .select("signal_type, signal_description, source_url, detected_at, confidence_score")
        .eq("lead_id", lead_id)
        .order("detected_at", { ascending: false })
        .limit(10),
      // 3. Interactions (most recent)
      adminClient.from("interactions")
        .select("type, subject, body_text, direction, occurred_at, ai_summary")
        .eq("lead_id", lead_id)
        .order("occurred_at", { ascending: false })
        .limit(20),
      // 4. Enrichment data
      adminClient.from("entity_enrichment")
        .select("results, signals")
        .eq("lead_id", lead_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // 5. KB chunks (strategy + industry context)
      adminClient.from("kb_chunks")
        .select("content, content_type, title")
        .eq("processing_status", "completed")
        .eq("allowed_customer_facing", true)
        .in("content_type", ["strategy", "industry", "knowledge"])
        .limit(4),
    ]);

    const lead = leadResult.data;
    if (!lead) {
      return new Response(JSON.stringify({ ok: false, error: "Lead not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build signals array
    const signals = (signalsResult.data || []).map((s: any) => ({
      type: s.signal_type,
      description: s.signal_description,
      source: s.source_url || "",
    }));

    // Build interactions summary
    const interactions = interactionsResult.data || [];
    const interactionLines = interactions.slice(0, 10).map((i: any) => {
      const dir = i.direction === "inbound" ? "IN" : "OUT";
      const summary = i.ai_summary || i.body_text?.slice(0, 150) || "";
      return `[${dir}] ${i.subject || i.type}: ${summary}`;
    });
    const previousInteractionsSummary = interactionLines.join("\n") || "No interactions recorded yet.";

    // Build enrichment-based company summary
    const enrichment = enrichmentResult.data;
    let companySummary = `${lead.company}`;
    if (lead.industry) companySummary += ` | Industry: ${lead.industry}`;
    if (lead.city || lead.country) companySummary += ` | Location: ${[lead.city, lead.state, lead.country].filter(Boolean).join(", ")}`;
    if (enrichment?.signals && Array.isArray(enrichment.signals)) {
      const enrichSignals = (enrichment.signals as any[]).slice(0, 3).map((s: any) => s.signal || s.snippet || "").filter(Boolean);
      if (enrichSignals.length > 0) companySummary += ` | Enrichment: ${enrichSignals.join("; ")}`;
    }

    // Build lead role summary
    const leadRoleSummary = [
      lead.name,
      lead.job_title ? `(${lead.job_title})` : "",
      lead.company ? `at ${lead.company}` : "",
      lead.stage ? `| Stage: ${lead.stage}` : "",
      lead.motion ? `| Motion: ${lead.motion}` : "",
    ].filter(Boolean).join(" ");

    // Build industry context from KB
    const kbChunks = kbResult.data || [];
    const industryContext = kbChunks
      .filter((c: any) => c.content_type === "industry" || c.content_type === "strategy")
      .map((c: any) => c.content)
      .join("\n")
      .slice(0, 800) || "No industry-specific context available.";

    // Step 5: Generate recommended angles via LLM
    let recommendedAngles: string[] = [];
    if (LOVABLE_API_KEY && (signals.length > 0 || interactions.length > 0)) {
      try {
        const anglePrompt = `Based on the following lead context, suggest 3-5 short recommended outreach angles (one sentence each).

Lead: ${lead.name} (${lead.job_title || "Unknown role"}) at ${lead.company}
Industry: ${lead.industry || "Unknown"}
Stage: ${lead.stage}
Motion: ${lead.motion}
Signals: ${signals.length > 0 ? signals.map(s => `${s.type}: ${s.description}`).join("; ") : "None"}
Recent interactions: ${interactionLines.slice(0, 5).join("; ") || "None"}

Return a JSON array of strings only, e.g. ["angle1", "angle2", "angle3"]. No markdown, no explanation.`;

        const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [{ role: "user", content: anglePrompt }],
          }),
        });

        if (aiResp.ok) {
          const aiData = await aiResp.json();
          const content = aiData.choices?.[0]?.message?.content || "";
          const cleaned = content.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
          try {
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) recommendedAngles = parsed.slice(0, 5);
          } catch { /* ignore parse errors */ }
        } else {
          await aiResp.text(); // consume body
        }
      } catch (err) {
        console.error("[build-lead-context] Angle generation failed:", err);
      }
    }

    // Resolve workspace_id from lead ownership
    const { data: membership } = await adminClient
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", lead.owner_user_id)
      .limit(1)
      .maybeSingle();

    const workspaceId = membership?.workspace_id;
    if (!workspaceId) {
      return new Response(JSON.stringify({ ok: false, error: "Could not resolve workspace" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build final context_json
    const contextJson: LeadContextJson = {
      company_summary: companySummary,
      lead_role_summary: leadRoleSummary,
      signals,
      recommended_angles: recommendedAngles,
      industry_context: industryContext,
      previous_interactions_summary: previousInteractionsSummary,
      generated_at: new Date().toISOString(),
    };

    // Upsert into cache
    const { error: upsertError } = await adminClient
      .from("lead_context_cache")
      .upsert(
        {
          lead_id,
          workspace_id: workspaceId,
          context_json: contextJson,
          last_generated_at: new Date().toISOString(),
        },
        { onConflict: "lead_id" }
      );

    if (upsertError) {
      console.error("[build-lead-context] Upsert error:", upsertError);
    }

    console.log(`[build-lead-context] ✅ Context built for ${lead_id}: ${signals.length} signals, ${interactions.length} interactions, ${recommendedAngles.length} angles`);

    return new Response(JSON.stringify({ ok: true, context: contextJson, cached: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[build-lead-context] Error:", error);
    return new Response(JSON.stringify({ ok: false, error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
