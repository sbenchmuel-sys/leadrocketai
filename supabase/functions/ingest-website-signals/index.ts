import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { ingestSignals, type SignalInput } from "../_shared/signalIngestion.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Keywords to detect on website content
const WEBSITE_SIGNAL_KEYWORDS: Record<string, string[]> = {
  product_launch: ["launch", "introducing", "announcing", "new product", "new feature", "just released", "now available"],
  partnership: ["partnership", "partner", "collaboration", "alliance", "integration", "teaming up"],
  expansion: ["expansion", "new office", "new market", "international", "global expansion", "opening"],
  hiring: ["hiring", "join our team", "careers", "open positions", "we're growing"],
  funding: ["funding", "raised", "series", "investment round", "backed by"],
  press_coverage: ["press", "featured in", "as seen in", "media", "award", "recognized"],
};

function extractWebsiteSignals(content: string, url: string): Omit<SignalInput, "lead_id">[] {
  const signals: Omit<SignalInput, "lead_id">[] = [];
  const text = content.toLowerCase();
  const seen = new Set<string>();

  for (const [signalType, keywords] of Object.entries(WEBSITE_SIGNAL_KEYWORDS)) {
    if (seen.has(signalType)) continue;
    for (const kw of keywords) {
      if (text.includes(kw)) {
        // Extract a snippet around the keyword
        const idx = text.indexOf(kw);
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + kw.length + 80);
        const snippet = content.slice(start, end).replace(/\s+/g, " ").trim();

        seen.add(signalType);
        signals.push({
          signal_type: signalType,
          signal_description: snippet.slice(0, 120),
          signal_source: "website",
          confidence_score: 0.6,
          source_url: url,
        });
        break;
      }
    }
  }

  return signals;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify user
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { lead_id, website_url } = body as { lead_id: string; website_url: string };

    if (!lead_id || !website_url) {
      return new Response(JSON.stringify({ error: "lead_id and website_url are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the website content (homepage)
    let pageContent = "";
    const urls = [website_url];

    // Also try /blog if not already a blog URL
    if (!website_url.includes("/blog")) {
      const blogUrl = website_url.replace(/\/$/, "") + "/blog";
      urls.push(blogUrl);
    }

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "LeadRocket-SignalBot/1.0" },
          redirect: "follow",
        });
        if (res.ok) {
          const html = await res.text();
          // Strip HTML tags for keyword matching
          const textContent = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .slice(0, 50000); // Limit to 50k chars
          pageContent += " " + textContent;
        }
      } catch (err) {
        logger.warn("website_fetch_error", { url, error: String(err) });
      }
    }

    if (!pageContent.trim()) {
      return new Response(JSON.stringify({ signals: [], message: "Could not fetch website content" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Extract signals
    const rawSignals = extractWebsiteSignals(pageContent, website_url);
    const signals: SignalInput[] = rawSignals.map((s) => ({ ...s, lead_id }));

    // Ingest
    const admin = createClient(supabaseUrl, serviceKey);
    const result = await ingestSignals(admin, signals);

    logger.info("website_signals_complete", { lead_id, website_url, ...result });

    return new Response(JSON.stringify({ ok: true, ...result, signals: rawSignals.map(s => s.signal_type) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error("website_signals_error", { error: String(err) });
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
