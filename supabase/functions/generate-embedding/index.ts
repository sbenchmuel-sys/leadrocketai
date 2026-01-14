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

    console.log(`[generate-embedding] Processing chunk_id: ${chunk_id || 'none'}, text length: ${text.length}`);

    // Note: Lovable AI gateway doesn't support embedding models
    // We'll use PostgreSQL full-text search instead of vector similarity
    // This function now just marks chunks as "completed" for text-based search

    // If chunk_id is provided, update the chunk status to completed
    if (chunk_id) {
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

      // Generate a simple text search vector using PostgreSQL's to_tsvector
      // We'll mark the chunk as completed since we're using text search
      const { error: updateError } = await supabaseAdmin
        .from("kb_chunks")
        .update({
          processing_status: "completed",
          // Note: embedding column left null - we use text search instead
        })
        .eq("id", chunk_id);

      if (updateError) {
        console.error("[generate-embedding] Failed to update chunk:", updateError);
        return new Response(JSON.stringify({ ok: false, error: "Failed to update chunk" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[generate-embedding] Marked chunk ${chunk_id} as completed (using text search)`);
    }

    return new Response(
      JSON.stringify({ ok: true, message: "Chunk marked as completed for text-based search" }),
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
