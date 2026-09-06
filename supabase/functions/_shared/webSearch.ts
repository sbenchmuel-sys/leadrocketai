// ============================================================
// webSearch — the one web-search provider abstraction (SerpAPI or Google CSE,
// picked by ENRICHMENT_PROVIDER). Extracted from enrich-company-search so the
// LinkedIn-profile lookup (enrich-lead-linkedin) uses the same key and quota.
// ============================================================
import { logger } from "./logger.ts";

// ---- Provider abstraction ----

export interface SearchResult {
  title: string;
  snippet: string;
  link: string;
}

const provider = Deno.env.get("ENRICHMENT_PROVIDER") ?? "serpapi";

export async function runSearch(query: string): Promise<SearchResult[]> {
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

