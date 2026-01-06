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

    const { text, title, source, allowed_customer_facing = true } = await req.json();

    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing or invalid text" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[process-knowledge-document] Processing document: ${title || 'Untitled'}, text length: ${text.length}`);

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

    for (const chunk of insertedChunks || []) {
      try {
        // Generate embedding using chat model (Lovable AI doesn't support embedding models)
        const embResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
                content: chunk.content.slice(0, 8000)
              }
            ],
            temperature: 0,
          }),
        });

        if (!embResponse.ok) {
          console.error(`[process-knowledge-document] Embedding failed for chunk ${chunk.id}:`, embResponse.status);
          await supabaseAdmin.from("kb_chunks").update({ processing_status: "failed" }).eq("id", chunk.id);
          continue;
        }

        const embData = await embResponse.json();
        const content = embData.choices?.[0]?.message?.content || "";
        
        // Parse the embedding array from the response
        try {
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (!jsonMatch) throw new Error("No array found");
          
          let embedding: number[] = JSON.parse(jsonMatch[0]);
          
          // Normalize to 384 dimensions
          while (embedding.length < 384) embedding.push(0);
          embedding = embedding.slice(0, 384);
          
          // Update chunk with embedding
          await supabaseAdmin
            .from("kb_chunks")
            .update({
              embedding: `[${embedding.join(",")}]`,
              processing_status: "completed",
            })
            .eq("id", chunk.id);

          embeddingsGenerated++;
        } catch (parseError) {
          console.error(`[process-knowledge-document] Failed to parse embedding for chunk ${chunk.id}:`, parseError);
          await supabaseAdmin.from("kb_chunks").update({ processing_status: "failed" }).eq("id", chunk.id);
        }
      } catch (embError) {
        console.error(`[process-knowledge-document] Error generating embedding for chunk ${chunk.id}:`, embError);
        await supabaseAdmin.from("kb_chunks").update({ processing_status: "failed" }).eq("id", chunk.id);
      }
    }

    console.log(`[process-knowledge-document] Generated ${embeddingsGenerated} embeddings`);

    return new Response(
      JSON.stringify({
        ok: true,
        document_id: documentId,
        chunks_created: insertedChunks?.length || 0,
        embeddings_generated: embeddingsGenerated,
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
