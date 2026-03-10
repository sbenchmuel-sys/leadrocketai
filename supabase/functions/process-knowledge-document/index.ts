import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Valid content_type values for Sales Brain
const VALID_CONTENT_TYPES = [
  "knowledge", "messaging", "objection", "discovery",
  "industry", "competitor", "signal", "strategy", "case_study",
] as const;

type ContentType = typeof VALID_CONTENT_TYPES[number];

function isValidContentType(v: string): v is ContentType {
  return (VALID_CONTENT_TYPES as readonly string[]).includes(v);
}

// Smart chunking — title is stored as metadata, NOT prefixed into content
function chunkText(text: string, maxChunkSize = 600, overlapSize = 100): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  let currentChunk = "";
  let lastSentences: string[] = [];
  
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      
      const overlapText = lastSentences.slice(-2).join(" ");
      currentChunk = overlapText.length < overlapSize ? overlapText + " " : "";
      lastSentences = [];
    }
    
    currentChunk += sentence + " ";
    lastSentences.push(sentence);
  }
  
  if (currentChunk.trim().length > 50) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Generate embeddings via OpenAI text-embedding-3-small
async function generateEmbeddings(texts: string[], apiKey: string): Promise<(number[] | null)[]> {
  const BATCH_SIZE = 50; // OpenAI supports up to 2048 inputs, but keep batches reasonable
  const results: (number[] | null)[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: batch,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[process-knowledge-document] OpenAI embeddings error (${response.status}):`, errText.slice(0, 300));
        // Return nulls for this batch
        results.push(...batch.map(() => null));
        continue;
      }

      const data = await response.json();
      for (const item of data.data) {
        results.push(item.embedding);
      }
    } catch (err) {
      console.error("[process-knowledge-document] Embedding generation failed:", err);
      results.push(...batch.map(() => null));
    }
  }

  return results;
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

    const {
      text,
      title,
      source,
      allowed_customer_facing = true,
      lead_id = null,
      content_type = "knowledge",
      segment = null,
      tags = null,
      priority = 1,
    } = await req.json();

    const safeContentType: ContentType = isValidContentType(content_type) ? content_type : "knowledge";

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "Missing or invalid text" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (text.trim().length < 50) {
      console.warn(`[process-knowledge-document] Very short text (${text.trim().length} chars)`);
      return new Response(JSON.stringify({ 
        ok: false, 
        error: "The document appears to contain very little extractable text. It may be a scanned or image-based PDF. Please try uploading a text-based document instead." 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify lead ownership if lead_id is provided
    let verified_lead_id: string | null = null;
    if (lead_id) {
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .select("id, owner_user_id")
        .eq("id", lead_id)
        .single();

      if (leadError || !lead || lead.owner_user_id !== user.id) {
        console.warn(`[process-knowledge-document] Lead ownership verification failed for lead_id: ${lead_id}, user: ${user.id}`);
        return new Response(
          JSON.stringify({ ok: false, error: "Lead not found or access denied" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      verified_lead_id = lead_id;
    }

    console.log(`[process-knowledge-document] Processing: ${title || 'Untitled'}, length: ${text.length}, content_type: ${safeContentType}, lead_id: ${verified_lead_id || 'global'}`);

    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Delete old chunks with same source
    if (source) {
      const { data: oldChunks, error: deleteErr } = await supabaseAdmin
        .from("kb_chunks")
        .delete()
        .eq("owner_user_id", user.id)
        .eq("source", source)
        .select("id");
      
      if (deleteErr) {
        console.warn(`[process-knowledge-document] Failed to delete old chunks for source "${source}":`, deleteErr);
      } else if (oldChunks && oldChunks.length > 0) {
        console.log(`[process-knowledge-document] Deleted ${oldChunks.length} old chunks for source "${source}"`);
      }
    }

    const documentId = crypto.randomUUID();
    const chunks = chunkText(text, 600, 100);
    console.log(`[process-knowledge-document] Created ${chunks.length} chunks`);

    // Generate embeddings if OpenAI key is available
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    let embeddings: (number[] | null)[] = [];
    let embeddingsGenerated = 0;
    let embeddingsFailed = 0;

    if (openaiKey) {
      console.log(`[process-knowledge-document] Generating embeddings for ${chunks.length} chunks...`);
      embeddings = await generateEmbeddings(chunks, openaiKey);
      embeddingsGenerated = embeddings.filter(e => e !== null).length;
      embeddingsFailed = embeddings.filter(e => e === null).length;
      console.log(`[process-knowledge-document] Embeddings: ${embeddingsGenerated} success, ${embeddingsFailed} failed`);
    } else {
      console.warn("[process-knowledge-document] OPENAI_API_KEY not set — skipping embedding generation, falling back to text search");
    }

    // Insert chunks with embeddings
    const chunkInserts = chunks.map((content, index) => {
      const embedding = embeddings[index] || null;
      return {
        content,
        title: title || null,
        source: source || null,
        allowed_customer_facing,
        owner_user_id: user.id,
        document_id: documentId,
        chunk_index: index,
        processing_status: "completed",
        lead_id: verified_lead_id,
        content_type: safeContentType,
        segment: segment || null,
        tags: Array.isArray(tags) ? tags : null,
        priority: typeof priority === "number" ? priority : 1,
        // Store embedding as a JSON string of the vector for pgvector
        embedding: embedding ? JSON.stringify(embedding) : null,
      };
    });

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

    const totalInserted = insertedChunks?.length || 0;
    console.log(`[process-knowledge-document] Inserted ${totalInserted} chunks, ${embeddingsGenerated} with embeddings`);

    return new Response(
      JSON.stringify({
        ok: true,
        document_id: documentId,
        chunks_created: totalInserted,
        embeddings_generated: embeddingsGenerated,
        embeddings_failed: embeddingsFailed,
        lead_id: verified_lead_id || null,
        message: openaiKey
          ? `${embeddingsGenerated} chunks indexed with semantic embeddings`
          : "Chunks indexed for text-based search (no OPENAI_API_KEY configured)"
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
