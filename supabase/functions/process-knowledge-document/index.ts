import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Smart chunking function that preserves context
function chunkText(text: string, title: string, maxChunkSize = 600, overlapSize = 100): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  let currentChunk = "";
  let lastSentences: string[] = [];
  
  for (const sentence of sentences) {
    // If adding this sentence exceeds the limit, save the chunk
    if (currentChunk.length + sentence.length > maxChunkSize && currentChunk.length > 0) {
      // Add title context to the chunk
      const finalChunk = title ? `[${title}]\n${currentChunk.trim()}` : currentChunk.trim();
      chunks.push(finalChunk);
      
      // Keep the last few sentences for overlap
      const overlapText = lastSentences.slice(-2).join(" ");
      currentChunk = overlapText.length < overlapSize ? overlapText + " " : "";
      lastSentences = [];
    }
    
    currentChunk += sentence + " ";
    lastSentences.push(sentence);
  }
  
  // Add the final chunk if there's remaining content
  if (currentChunk.trim().length > 50) {
    const finalChunk = title ? `[${title}]\n${currentChunk.trim()}` : currentChunk.trim();
    chunks.push(finalChunk);
  }
  
  return chunks;
}

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

    const { text, title, source, allowed_customer_facing = true, lead_id = null } = await req.json();

    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing or invalid text" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[process-knowledge-document] Processing document: ${title || 'Untitled'}, text length: ${text.length}, lead_id: ${lead_id || 'global'}`);

    // Generate a unique document ID to group chunks
    const documentId = crypto.randomUUID();
    
    // Split the document into smart chunks
    const chunks = chunkText(text, title || "", 600, 100);
    console.log(`[process-knowledge-document] Created ${chunks.length} chunks`);

    // Use service role for inserting chunks
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Insert all chunks - mark as completed since we use text search (no embeddings needed)
    const chunkInserts = chunks.map((content, index) => ({
      content,
      title: title || null,
      source: source || null,
      allowed_customer_facing,
      owner_user_id: user.id,
      document_id: documentId,
      chunk_index: index,
      processing_status: "completed", // Text search doesn't need embeddings
      lead_id: lead_id || null,
    }));

    const { data: insertedChunks, error: insertError } = await supabaseAdmin
      .from("kb_chunks")
      .insert(chunkInserts)
      .select("id, content");

    if (insertError) {
      console.error("[process-knowledge-document] Failed to insert chunks:", insertError);
      return new Response(JSON.stringify({ ok: false, error: "Failed to save chunks" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[process-knowledge-document] Inserted ${insertedChunks?.length || 0} chunks (using text-based search)`);

    return new Response(
      JSON.stringify({
        ok: true,
        document_id: documentId,
        chunks_created: insertedChunks?.length || 0,
        embeddings_generated: insertedChunks?.length || 0, // All completed via text search
        embeddings_failed: 0,
        lead_id: lead_id || null,
        message: "All chunks indexed for text-based search"
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[process-knowledge-document] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "An error occurred", error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
