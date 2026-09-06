// ============================================================================
// enrich-lead-linkedin — find missing LinkedIn profile URLs for leads (Sprint 3).
//
// Called from the client right after enrollment, for the enrolled leads that
// have no linkedin_url while the cadence has a LinkedIn step. Until now those
// leads simply had every LinkedIn touch auto-skipped ("no LinkedIn profile on
// file"). This runs one web search per lead through the SAME provider/key as
// enrich-company-search (_shared/webSearch.ts) and saves a URL only when the
// fail-closed matcher (_shared/linkedinLookup.ts) is sure it's the person.
//
// User-authenticated, owner-or-admin scoped per lead (mirrors the leads RLS),
// bounded per call, best-effort per lead (one failed search never fails the
// batch). Writes: leads.linkedin_url (only when still NULL) + a system_note on
// the lead's timeline saying where the URL came from.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth } from "../_shared/authz.ts";
import { runSearch } from "../_shared/webSearch.ts";
import { linkedinSearchQuery, pickLinkedinProfile } from "../_shared/linkedinLookup.ts";
import { projectTimelineItem } from "../_shared/timelineProjector.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// One search per lead costs a provider credit and ~1s. ponytail: 50 per call,
// 4 in flight — the client chunks bigger lists; a queue-backed job is the
// upgrade if lists in the thousands ever need this.
export const MAX_LEADS_PER_CALL = 50;
const CONCURRENCY = 4;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await requireAuth(req, corsHeaders);
  if (auth instanceof Response) return auth;

  let payload: { leadIds?: unknown };
  try { payload = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const leadIds = Array.isArray(payload.leadIds)
    ? [...new Set(payload.leadIds.filter((x): x is string => typeof x === "string"))].slice(0, MAX_LEADS_PER_CALL)
    : [];
  if (leadIds.length === 0) return json({ ok: false, error: "leadIds is required" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: leadRows } = await admin
    .from("leads")
    .select("id, name, company, linkedin_url, workspace_id, owner_user_id")
    .in("id", leadIds);
  const leads = (leadRows || []) as {
    id: string; name: string | null; company: string | null; linkedin_url: string | null;
    workspace_id: string; owner_user_id: string | null;
  }[];

  // Owner-or-admin per lead (mirrors the leads table's RLS). Service callers skip.
  let allowed = leads;
  if (!auth.isPrivileged) {
    const adminWs = new Set<string>();
    for (const wsId of new Set(leads.map((l) => l.workspace_id))) {
      const { data: isAdmin } = await admin.rpc("is_workspace_admin", { _workspace_id: wsId, _user_id: auth.userId! });
      if (isAdmin) adminWs.add(wsId);
    }
    allowed = leads.filter((l) => l.owner_user_id === auth.userId || adminWs.has(l.workspace_id));
  }

  const counters = { found: 0, notFound: 0, skipped: leadIds.length - allowed.length, failed: 0 };

  const lookup = async (lead: typeof allowed[number]) => {
    const name = (lead.name || "").trim();
    if (lead.linkedin_url || !name || name.split(/\s+/).length < 2) { counters.skipped++; return; }
    let url: string | null;
    try {
      url = pickLinkedinProfile(await runSearch(linkedinSearchQuery(name, lead.company)), name, lead.company);
    } catch (err) {
      counters.failed++;
      console.warn(`[enrich-lead-linkedin] search failed for lead ${lead.id}:`, err instanceof Error ? err.message : String(err));
      return;
    }
    if (!url) { counters.notFound++; return; }
    // Only fill an EMPTY slot — a URL the rep typed in meanwhile wins.
    const { data: updated } = await admin
      .from("leads").update({ linkedin_url: url }).eq("id", lead.id).is("linkedin_url", null).select("id");
    if (!(updated || []).length) { counters.skipped++; return; }
    counters.found++;
    try {
      await projectTimelineItem(admin, {
        workspace_id: lead.workspace_id,
        lead_id: lead.id,
        channel: "system",
        provider: "automation",
        event_type: "system_note",
        occurred_at: new Date().toISOString(),
        source_table: "leads",
        source_id: lead.id,
        snippet_text: `🔎 Found a LinkedIn profile automatically and added it to this lead: ${url}. LinkedIn steps in the outreach will use it.`,
        metadata_json: { linkedin_url: url, linkedin_url_source: "web_search" },
        dedupe_key: `linkedin_enrich_${lead.id}`,
      });
    } catch (err) {
      console.warn(`[enrich-lead-linkedin] timeline note failed for lead ${lead.id}:`, err instanceof Error ? err.message : String(err));
    }
  };

  // Small worker pool — bounded concurrency without a dependency.
  const queue = [...allowed];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let l = queue.shift(); l; l = queue.shift()) await lookup(l);
  }));

  console.log("[enrich-lead-linkedin]", JSON.stringify(counters));
  return json({ ok: true, ...counters });
});
