import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { resolvePDFJS } from "https://esm.sh/pdfjs-serverless@0.5.0";
import { BlobReader, ZipReader, TextWriter } from "https://deno.land/x/zipjs@v2.7.32/index.js";

// Dynamic CORS based on allowed origins
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  
  // In development, allow localhost origins
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || allowedOrigins.includes("*");
  
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

async function extractPdfText(data: Uint8Array): Promise<string> {
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
  
  return extractedText;
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Authentication check
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    console.error("[parse-document] Missing authorization header");
    return new Response(
      JSON.stringify({ error: "Missing authorization header" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    console.error("[parse-document] Unauthorized:", authError?.message);
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
      console.error("[parse-document] No file provided");
      return new Response(
        JSON.stringify({ error: "No file provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const fileName = file.name.toLowerCase();
    const arrayBuffer = await file.arrayBuffer();
    let extractedText = "";
    const title = file.name.replace(/\.(pdf|docx)$/i, "");

    console.log(`[parse-document] Processing file: ${file.name}, size: ${file.size} bytes`);

    if (fileName.endsWith(".pdf")) {
      const data = new Uint8Array(arrayBuffer);
      extractedText = await extractPdfText(data);
      console.log(`[parse-document] PDF parsed, extracted ${extractedText.length} characters`);
      
    } else if (fileName.endsWith(".docx")) {
      // DOCX files are ZIP archives containing XML
      const blob = new Blob([arrayBuffer]);
      const zipReader = new ZipReader(new BlobReader(blob));
      const entries = await zipReader.getEntries();
      
      // Find word/document.xml which contains the main content
      // deno-lint-ignore no-explicit-any
      const docEntry = entries.find((e: any) => e.filename === "word/document.xml");
      
      if (!docEntry || !docEntry.getData) {
        throw new Error("Invalid DOCX file: document.xml not found");
      }
      
      const xmlContent: string = await docEntry.getData(new TextWriter());
      await zipReader.close();
      
      // Extract text from <w:t> tags (Word text elements)
      const textMatches = xmlContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
      extractedText = textMatches
        .map((match: string) => match.replace(/<[^>]+>/g, ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      
      console.log(`[parse-document] DOCX parsed, extracted ${extractedText.length} characters`);
    } else {
      console.error(`[parse-document] Unsupported file type: ${fileName}`);
      return new Response(
        JSON.stringify({ error: "Unsupported file type. Please upload PDF or DOCX files." }),
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
    console.error(`[parse-document] Error ${errorId} processing file:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to parse document. Please ensure the file is valid.", error_id: errorId }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
