import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

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

    const { text, chunk_id } = await req.json();

    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing or invalid text" }), {
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

    console.log(`[generate-embedding] Generating embedding for text length: ${text.length}, chunk_id: ${chunk_id || 'none'}`);

    // Use Gemini chat model to generate a semantic hash/fingerprint for similarity matching
    // Since Lovable AI gateway doesn't support embedding models, we use chat to create semantic representations
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content: `You are a text embedding generator. Generate a 384-dimensional embedding vector for semantic similarity search.
Output ONLY a JSON array of exactly 384 floating point numbers between -1 and 1.
The numbers should represent the semantic meaning of the input text.
Similar texts should have similar vectors. No explanation, just the array.`
          },
          {
            role: "user",
            content: text.slice(0, 8000)
          }
        ],
        temperature: 0,
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
        return new Response(JSON.stringify({ ok: false, error: "Payment required. Please add credits." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error(`[generate-embedding] AI gateway error: ${response.status}`, errorText);
      return new Response(JSON.stringify({ ok: false, error: "Failed to generate embedding" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    
    // Parse the embedding array from the response
    let embedding: number[];
    try {
      // Extract JSON array from the response (handle markdown code blocks)
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error("No array found in response");
      }
      embedding = JSON.parse(jsonMatch[0]);
      
      // Validate it's an array of numbers
      if (!Array.isArray(embedding) || embedding.length === 0 || typeof embedding[0] !== "number") {
        throw new Error("Invalid embedding format");
      }
      
      // Normalize to 384 dimensions if needed
      while (embedding.length < 384) {
        embedding.push(0);
      }
      embedding = embedding.slice(0, 384);
    } catch (parseError) {
      console.error("[generate-embedding] Failed to parse embedding:", parseError, content.slice(0, 200));
      return new Response(JSON.stringify({ ok: false, error: "Failed to parse embedding response" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[generate-embedding] Generated embedding with ${embedding.length} dimensions`);

    // If chunk_id is provided, update the chunk directly
    if (chunk_id) {
      // Use service role to update embedding
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

      const { error: updateError } = await supabaseAdmin
        .from("kb_chunks")
        .update({
          embedding: `[${embedding.join(",")}]`,
          processing_status: "completed",
        })
        .eq("id", chunk_id);

      if (updateError) {
        console.error("[generate-embedding] Failed to update chunk:", updateError);
        return new Response(JSON.stringify({ ok: false, error: "Failed to update chunk with embedding" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[generate-embedding] Updated chunk ${chunk_id} with embedding`);
    }

    return new Response(
      JSON.stringify({ ok: true, embedding, dimensions: embedding.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[generate-embedding] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "An error occurred", error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
