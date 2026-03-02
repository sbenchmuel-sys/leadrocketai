import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";

// ---- CORS ----
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ---- Provider abstraction ----

interface SearchResult {
  title: string;
  snippet: string;
  link: string;
}

const provider = Deno.env.get("ENRICHMENT_PROVIDER") ?? "serpapi";

async function runSearch(query: string): Promise<SearchResult[]> {
  if (provider === "serpapi") return runSerpApi(query);
  if (provider === "google_cse") return runGoogleCSE(query);
  throw new Error(`Invalid ENRICHMENT_PROVIDER: ${provider}`);
}

async function runSerpApi(query: string): Promise<SearchResult[]> {
  const key = Deno.env.get("SERPAPI_API_KEY");
  if (!key) throw new Error("Missing SERPAPI_API_KEY");

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("engine", "google");
  url.searchParams.set("api_key", key);
  url.searchParams.set("num", "5");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    logger.error("serpapi_error", { status: res.status, error: errText });
    throw new Error(`SerpAPI failed: ${res.status}`);
  }

  const json = await res.json();
  return (json.organic_results ?? []).map((r: Record<string, string>) => ({
    title: r.title ?? "",
    snippet: r.snippet ?? "",
    link: r.link ?? "",
  }));
}

async function runGoogleCSE(query: string): Promise<SearchResult[]> {
  const key = Deno.env.get("GOOGLE_CSE_API_KEY");
  const cx = Deno.env.get("GOOGLE_CSE_ID");
  if (!key || !cx) throw new Error("Missing Google CSE config (GOOGLE_CSE_API_KEY / GOOGLE_CSE_ID)");

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("q", query);
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("num", "5");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    logger.error("google_cse_error", { status: res.status, error: errText });
    throw new Error(`Google CSE failed: ${res.status}`);
  }

  const json = await res.json();
  return (json.items ?? []).map((r: Record<string, string>) => ({
    title: r.title ?? "",
    snippet: r.snippet ?? "",
    link: r.link ?? "",
  }));
}

// ---- Signal extraction (deterministic, keyword-based) ----

const SIGNAL_KEYWORDS: Record<string, string[]> = {
  funding: ["funding", "raised", "series", "investment", "venture", "capital", "valuation", "investors"],
  hiring: ["hiring", "job", "careers", "openings", "recruit", "talent", "headcount", "growing team"],
  expansion: ["expansion", "new office", "new market", "launch", "international", "global"],
  product_launch: ["new product", "release", "launch", "announce", "beta", "feature"],
  leadership_change: ["ceo", "cto", "appointed", "new hire", "executive", "leadership"],
  partnership: ["partnership", "partner", "collaboration", "alliance", "integration"],
  news: ["news", "press release", "media", "coverage", "announcement"],
};

function extractSignals(results: SearchResult[]): { signal: string; source: string; snippet: string }[] {
  const signals: { signal: string; source: string; snippet: string }[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    const text = `${r.title} ${r.snippet}`.toLowerCase();
    for (const [signal, keywords] of Object.entries(SIGNAL_KEYWORDS)) {
      if (seen.has(signal)) continue;
      if (keywords.some((kw) => text.includes(kw))) {
        seen.add(signal);
        signals.push({ signal, source: r.link, snippet: r.snippet.slice(0, 120) });
      }
    }
  }
  return signals;
}

// ---- Main handler ----

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

    // Verify user
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
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
    const { lead_id, company, purpose, force } = body as {
      lead_id?: string;
      company?: string;
      purpose?: string;
      force?: boolean;
    };

    if (!company) {
      return new Response(JSON.stringify({ error: "company is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve workspace_id from lead or workspace_members
    const admin = createClient(supabaseUrl, serviceKey);
    let workspace_id: string | null = null;

    if (lead_id) {
      const { data: lead } = await admin
        .from("leads")
        .select("owner_user_id")
        .eq("id", lead_id)
        .single();

      if (lead) {
        // Get workspace through workspace_members for this user
        const { data: membership } = await admin
          .from("workspace_members")
          .select("workspace_id")
          .eq("user_id", user.id)
          .limit(1)
          .single();
        workspace_id = membership?.workspace_id ?? null;
      }
    }

    if (!workspace_id) {
      const { data: membership } = await admin
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", user.id)
        .limit(1)
        .single();
      workspace_id = membership?.workspace_id ?? null;
    }

    if (!workspace_id) {
      return new Response(JSON.stringify({ error: "No workspace found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check cache — unexpired row for same workspace + lead (skip if force refresh)
    if (lead_id && !force) {
      const { data: cached } = await admin
        .from("entity_enrichment")
        .select("*")
        .eq("workspace_id", workspace_id)
        .eq("lead_id", lead_id)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cached) {
        logger.info("enrichment_cache_hit", { lead_id, company });
        return new Response(JSON.stringify(cached), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Run 3 searches
    const queries = [
      `${company} funding`,
      `${company} hiring`,
      `${company} news`,
    ];

    const allResults: SearchResult[] = [];
    for (const q of queries) {
      try {
        const results = await runSearch(q);
        allResults.push(...results);
      } catch (err) {
        logger.warn("enrichment_search_partial_fail", { query: q, error: String(err) });
      }
    }

    // Extract signals
    const signals = extractSignals(allResults);

    // Store
    const row = {
      workspace_id,
      lead_id: lead_id ?? null,
      company,
      query: queries.join(" | "),
      provider,
      results: allResults,
      signals,
      requested_by_user_id: user.id,
    };

    const { data: inserted, error: insertErr } = await admin
      .from("entity_enrichment")
      .insert(row)
      .select()
      .single();

    if (insertErr) {
      logger.error("enrichment_insert_error", { error: insertErr.message });
      return new Response(JSON.stringify({ error: "Failed to store enrichment" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logger.info("enrichment_complete", { lead_id, company, provider, resultCount: allResults.length, signalCount: signals.length });

    return new Response(JSON.stringify(inserted), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error("enrichment_unhandled_error", { error: String(err) });
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
