import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

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

    // Insert all chunks
    const chunkInserts = chunks.map((content, index) => ({
      content,
      title: title || null,
      source: source || null,
      allowed_customer_facing,
      owner_user_id: user.id,
      document_id: documentId,
      chunk_index: index,
      processing_status: "pending",
      lead_id: lead_id || null, // New: associate with lead if provided
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

    console.log(`[process-knowledge-document] Inserted ${insertedChunks?.length || 0} chunks`);

    // Generate embeddings for each chunk
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY is not configured");
      // Still return success but mark as pending
      return new Response(JSON.stringify({ 
        ok: true, 
        document_id: documentId,
        chunks_created: insertedChunks?.length || 0,
        embeddings_generated: 0,
        message: "Chunks created but embeddings pending - AI gateway not configured"
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let embeddingsGenerated = 0;
    let embeddingsFailed = 0;
    const DELAY_BETWEEN_CHUNKS_MS = 800; // Rate limiting protection

    console.log(`[process-knowledge-document] Starting embedding generation for ${insertedChunks?.length || 0} chunks`);

    for (let i = 0; i < (insertedChunks?.length || 0); i++) {
      const chunk = insertedChunks![i];
      
      // Add delay between calls to avoid rate limiting (skip first)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CHUNKS_MS));
      }
      
      console.log(`[process-knowledge-document] Processing chunk ${i + 1}/${insertedChunks?.length}: ${chunk.id}`);
      
      // Retry logic with exponential backoff
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;
      
      while (attempts < maxAttempts && !success) {
        attempts++;
        try {
          // Use proper embedding API
          const embResponse = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/text-embedding-004",
              input: chunk.content.slice(0, 8000),
            }),
          });

          if (!embResponse.ok) {
            const status = embResponse.status;
            const errorText = await embResponse.text();
            console.error(`[process-knowledge-document] Embedding API error for chunk ${chunk.id}: ${status}`, errorText);
            
            // Handle rate limiting with longer backoff
            if (status === 429) {
              const backoffMs = Math.pow(2, attempts) * 2000; // 4s, 8s, 16s
              console.log(`[process-knowledge-document] Rate limited, waiting ${backoffMs}ms before retry...`);
              await new Promise(resolve => setTimeout(resolve, backoffMs));
              continue; // Retry
            }
            
            // For other errors, mark as failed and continue
            throw new Error(`API returned ${status}: ${errorText}`);
          }

          const embData = await embResponse.json();
          const embedding: number[] = embData.data?.[0]?.embedding;
          
          if (!embedding || !Array.isArray(embedding)) {
            throw new Error("Invalid embedding response format");
          }
          
          // Update chunk with embedding
          const { error: updateError } = await supabaseAdmin
            .from("kb_chunks")
            .update({
              embedding: `[${embedding.join(",")}]`,
              processing_status: "completed",
            })
            .eq("id", chunk.id);

          if (updateError) {
            throw new Error(`DB update failed: ${updateError.message}`);
          }

          embeddingsGenerated++;
          success = true;
          console.log(`[process-knowledge-document] Successfully generated embedding for chunk ${chunk.id}, dimensions: ${embedding.length}`);
          
        } catch (err) {
          console.error(`[process-knowledge-document] Attempt ${attempts}/${maxAttempts} failed for chunk ${chunk.id}:`, err);
          
          if (attempts >= maxAttempts) {
            embeddingsFailed++;
            await supabaseAdmin.from("kb_chunks").update({ processing_status: "failed" }).eq("id", chunk.id);
            console.error(`[process-knowledge-document] Giving up on chunk ${chunk.id} after ${maxAttempts} attempts`);
          } else {
            // Backoff before retry
            const backoffMs = Math.pow(2, attempts) * 1000;
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
        }
      }
    }

    console.log(`[process-knowledge-document] Completed: ${embeddingsGenerated} succeeded, ${embeddingsFailed} failed`);

    return new Response(
      JSON.stringify({
        ok: true,
        document_id: documentId,
        chunks_created: insertedChunks?.length || 0,
        embeddings_generated: embeddingsGenerated,
        lead_id: lead_id || null,
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
