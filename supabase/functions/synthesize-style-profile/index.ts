import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI gateway not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { channel, motion_type } = await req.json();
    if (!channel || !motion_type) {
      return new Response(JSON.stringify({ error: "channel and motion_type required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Check if learning is paused
    const { data: directive } = await adminClient
      .from("user_style_directives")
      .select("directive_text, learning_paused")
      .eq("user_id", user.id)
      .maybeSingle();

    if (directive?.learning_paused) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "learning_paused" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch last 50 examples for this user+channel+motion, weighted
    const { data: examples, error: exErr } = await adminClient
      .from("style_examples")
      .select("body_text, subject, feedback, feedback_comment, created_at")
      .eq("user_id", user.id)
      .eq("channel", channel)
      .eq("motion_type", motion_type)
      .order("created_at", { ascending: false })
      .limit(50);

    if (exErr || !examples || examples.length < 5) {
      console.log(`[synthesize-style] Insufficient examples: ${examples?.length ?? 0}`);
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "insufficient_examples", count: examples?.length ?? 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build the synthesis prompt
    const exampleBlocks: string[] = [];
    const dislikedBlocks: string[] = [];

    for (const ex of examples) {
      const label = ex.feedback === "liked" ? "[LIKED]" : ex.feedback === "disliked" ? "[DISLIKED]" : "[SENT]";
      const text = ex.subject ? `Subject: ${ex.subject}\n${ex.body_text}` : ex.body_text;
      if (ex.feedback === "disliked") {
        dislikedBlocks.push(`${label} ${text.slice(0, 500)}${ex.feedback_comment ? `\nUser comment: ${ex.feedback_comment}` : ""}`);
      } else {
        exampleBlocks.push(`${label} ${text.slice(0, 500)}`);
      }
    }

    const channelSpecificFeatures = channel === "email"
      ? "opening_style, closing_style, tone_markers (array), avg_paragraph_count, uses_bullets, personalization_density, cta_pattern, signature_style"
      : channel === "sms"
      ? "avg_length_chars, uses_emoji, tone_markers (array), cta_pattern, greeting_style"
      : "avg_length_chars, uses_emoji, multi_message, tone_markers (array), cta_pattern, greeting_style";

    const synthesisPrompt = `You are a writing style analyst. Analyze the following ${examples.length} ${channel} messages written by a sales rep for "${motion_type}" scenarios.

LIKED messages should carry 2x weight. DISLIKED messages define anti-patterns (what NOT to do).
SENT messages are passive examples with normal weight.

${directive?.directive_text ? `The user describes their voice as: "${directive.directive_text}"\nUse this as an anchor for your analysis.` : ""}

=== MESSAGES (${channel}, ${motion_type}) ===
${exampleBlocks.slice(0, 30).join("\n\n---\n\n")}

${dislikedBlocks.length > 0 ? `=== DISLIKED MESSAGES (anti-patterns) ===\n${dislikedBlocks.join("\n\n---\n\n")}` : ""}

=== INSTRUCTIONS ===
Produce a JSON style profile with these fields:
- preferred_opening: string (e.g. "direct_question", "observation", "reference_to_context")
- tone: string (e.g. "direct, slightly informal")
- structure: string (e.g. "2-3 short paragraphs, no bullets")
- cta_style: string (e.g. "question_based, never 'let me know'")
- personalization: string (e.g. "always references company-specific context")
- anti_patterns: string[] (things the user NEVER does or explicitly disliked)
- tone_markers: string[] (e.g. ["confident", "casual"])
- ${channelSpecificFeatures}
- confidence: "low" | "medium" | "high" based on example consistency

Respond with ONLY the JSON object, no markdown.`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are a writing style analyst. Output only valid JSON." },
          { role: "user", content: synthesisPrompt },
        ],
      }),
    });

    if (!aiResponse.ok) {
      console.error(`[synthesize-style] AI error: ${aiResponse.status}`);
      return new Response(JSON.stringify({ error: "AI synthesis failed" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiResult = await aiResponse.json();
    const content = aiResult.choices?.[0]?.message?.content || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[synthesize-style] No JSON in AI response");
      return new Response(JSON.stringify({ error: "AI returned invalid format" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const profileJson = JSON.parse(jsonMatch[0]);

    // Resolve workspace_id
    const { data: membership } = await adminClient
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (!membership?.workspace_id) {
      return new Response(JSON.stringify({ error: "No workspace found" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Upsert the profile
    const { error: upsertErr } = await adminClient
      .from("user_style_profiles")
      .upsert({
        user_id: user.id,
        workspace_id: membership.workspace_id,
        channel,
        motion_type,
        profile_json: profileJson,
        example_count: examples.length,
        last_synthesized_at: new Date().toISOString(),
      }, { onConflict: "user_id,channel,motion_type" });

    if (upsertErr) {
      console.error("[synthesize-style] Upsert failed:", upsertErr);
      return new Response(JSON.stringify({ error: "Failed to save profile" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[synthesize-style] ✅ Profile saved: ${channel}/${motion_type}, ${examples.length} examples`);
    return new Response(JSON.stringify({ ok: true, profile: profileJson, example_count: examples.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[synthesize-style] Error:", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
