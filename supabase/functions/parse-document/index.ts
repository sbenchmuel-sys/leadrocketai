import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolvePDFJS } from "https://cdn.jsdelivr.net/npm/pdfjs-serverless@0.5.0/+esm";
import { BlobReader, ZipReader, TextWriter } from "https://deno.land/x/zipjs@v2.7.52/index.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Convert Uint8Array to base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Try basic PDF text extraction first
async function extractPdfText(data: Uint8Array): Promise<string> {
  try {
    const pdfjs = await resolvePDFJS();
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
    
    let extractedText = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // deno-lint-ignore no-explicit-any
      const pageText = content.items.map((item: any) => item.str || "").join(" ");
      extractedText += pageText + "\n";
    }
    
    return extractedText.trim();
  } catch (e) {
    console.warn("[parse-document] pdfjs extraction failed:", e);
    return "";
  }
}

// Use Lovable AI vision model to extract text from a PDF as base64 image
async function extractWithAI(fileBase64: string, fileName: string, mimeType: string): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    throw new Error("LOVABLE_API_KEY not configured");
  }

  console.log(`[parse-document] Using AI vision to extract text from: ${fileName}`);

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-pro",
      messages: [
        {
          role: "system",
          content: `You are a document text extraction assistant. Extract ALL text content from the provided document image/file. 
Preserve the document structure including:
- Headings and subheadings
- Paragraphs and line breaks
- Bullet points and numbered lists
- Table data (format as readable text)
- Any captions or footnotes

Return ONLY the extracted text content, no commentary or explanations. If the document contains no readable text, return "NO_TEXT_FOUND".`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract all text from this document: ${fileName}`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${fileBase64}`
              }
            }
          ]
        }
      ],
      max_tokens: 16000,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("[parse-document] AI extraction failed:", response.status, errText);
    
    if (response.status === 429) {
      throw new Error("AI rate limit exceeded. Please try again in a moment.");
    }
    if (response.status === 402) {
      throw new Error("AI usage limit reached. Please add credits to your workspace.");
    }
    throw new Error(`AI extraction failed: ${response.status}`);
  }

  const result = await response.json();
  const extractedText = result.choices?.[0]?.message?.content || "";
  
  if (extractedText === "NO_TEXT_FOUND" || extractedText.trim().length === 0) {
    return "";
  }

  console.log(`[parse-document] AI extracted ${extractedText.length} characters`);
  return extractedText;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: "Missing authorization header" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const jwt = authHeader.replace("Bearer ", "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  console.log(`[parse-document] Authenticated user: ${user.id}`);

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return new Response(
        JSON.stringify({ error: "No file provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const fileName = file.name.toLowerCase();
    const arrayBuffer = await file.arrayBuffer();
    const fileBytes = new Uint8Array(arrayBuffer);
    let extractedText = "";
    const title = file.name.replace(/\.(pdf|docx)$/i, "");

    console.log(`[parse-document] Processing file: ${file.name}, size: ${file.size} bytes`);

    if (fileName.endsWith(".pdf")) {
      // Step 1: Try fast pdfjs extraction
      extractedText = await extractPdfText(fileBytes);
      console.log(`[parse-document] pdfjs extracted ${extractedText.length} characters`);

      // Step 2: If pdfjs got very little text, use AI vision as fallback
      if (extractedText.trim().length < 100) {
        console.log(`[parse-document] Text too short (${extractedText.trim().length} chars), falling back to AI vision`);
        const base64 = uint8ArrayToBase64(fileBytes);
        const aiText = await extractWithAI(base64, file.name, "application/pdf");
        if (aiText.length > extractedText.trim().length) {
          extractedText = aiText;
          console.log(`[parse-document] AI vision produced ${extractedText.length} characters`);
        }
      }
      
    } else if (fileName.endsWith(".docx")) {
      // DOCX: try XML extraction first
      const blob = new Blob([arrayBuffer]);
      const zipReader = new ZipReader(new BlobReader(blob));
      const entries = await zipReader.getEntries();
      
      // deno-lint-ignore no-explicit-any
      const docEntry = entries.find((e: any) => e.filename === "word/document.xml");
      
      if (docEntry && docEntry.getData) {
        const xmlContent: string = await docEntry.getData(new TextWriter());
        await zipReader.close();
        
        const textMatches = xmlContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
        extractedText = textMatches
          .map((match: string) => match.replace(/<[^>]+>/g, ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        
        console.log(`[parse-document] DOCX XML extracted ${extractedText.length} characters`);
      } else {
        await zipReader.close();
      }

      // If DOCX extraction got very little text, try AI
      if (extractedText.trim().length < 100) {
        console.log(`[parse-document] DOCX text too short, falling back to AI vision`);
        const base64 = uint8ArrayToBase64(fileBytes);
        const aiText = await extractWithAI(base64, file.name, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        if (aiText.length > extractedText.trim().length) {
          extractedText = aiText;
        }
      }
    } else {
      return new Response(
        JSON.stringify({ error: "Unsupported file type. Please upload PDF or DOCX files." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Final check
    if (extractedText.trim().length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "Could not extract any text from the document. The file may be corrupted or contain only images without readable text." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        text: extractedText.trim(),
        title,
        source: file.name,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorId = crypto.randomUUID();
    const errorMessage = error instanceof Error ? error.message : "Failed to parse document";
    console.error(`[parse-document] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ error: errorMessage, error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
