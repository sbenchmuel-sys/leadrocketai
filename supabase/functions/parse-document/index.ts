import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import pdfParse from "https://esm.sh/pdf-parse@1.1.1";
import mammoth from "https://esm.sh/mammoth@1.6.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

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
      const uint8Array = new Uint8Array(arrayBuffer);
      const data = await pdfParse(uint8Array);
      extractedText = data.text;
      console.log(`[parse-document] PDF parsed, extracted ${extractedText.length} characters`);
    } else if (fileName.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ arrayBuffer });
      extractedText = result.value;
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
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[parse-document] Error processing file:", error);
    return new Response(
      JSON.stringify({ error: `Failed to parse document: ${errorMessage}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
