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

    // Retry logic with exponential backoff
    const maxAttempts = 3;
    let lastError: Error | null = null;
    let embedding: number[] | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[generate-embedding] Attempt ${attempt}/${maxAttempts}`);
        
        // Use proper embedding API
        const response = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/text-embedding-004",
            input: text.slice(0, 8000),
          }),
        });

        if (!response.ok) {
          const status = response.status;
          
          if (status === 429) {
            // Rate limited - exponential backoff
            const backoffMs = Math.pow(2, attempt) * 2000;
            console.log(`[generate-embedding] Rate limited (429), waiting ${backoffMs}ms before retry...`);
            if (attempt < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, backoffMs));
              continue;
            }
            return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded. Please try again later.", retryable: true }), {
              status: 429,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          if (status === 402) {
            return new Response(JSON.stringify({ ok: false, error: "Payment required. Please add credits." }), {
              status: 402,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          
          const errorText = await response.text();
          console.error(`[generate-embedding] AI gateway error: ${status}`, errorText);
          lastError = new Error(`API returned ${status}: ${errorText}`);
          
          if (attempt < maxAttempts) {
            const backoffMs = Math.pow(2, attempt) * 1000;
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
        } else {
          const data = await response.json();
          embedding = data.data?.[0]?.embedding;
          
          if (!embedding || !Array.isArray(embedding)) {
            throw new Error("Invalid embedding response format");
          }
          
          console.log(`[generate-embedding] Successfully generated embedding on attempt ${attempt}, dimensions: ${embedding.length}`);
          break; // Success!
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[generate-embedding] Attempt ${attempt} failed:`, lastError.message);
        
        if (attempt < maxAttempts) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    if (!embedding) {
      console.error("[generate-embedding] All attempts failed:", lastError?.message);
      return new Response(JSON.stringify({ ok: false, error: lastError?.message || "Failed to generate embedding" }), {
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
