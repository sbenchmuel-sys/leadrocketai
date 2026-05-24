// ============================================================
// classify-outbound — durable summarizer for outbound emails
//
// Mirrors classify-inbound but for `event_type = 'email_outbound'`.
// Writes a 1–2 sentence paraphrased summary into
// `metadata_json.ai_summary` so that AFTER the 30-day raw body purge
// (see expire_old_messages), reply-generation paths still have
// durable context for "what did we previously promise this customer".
//
// No intent classification — outbound rows don't drive queue routing.
// Just the summary. Re-entrancy-safe: write is gated by
// "ai_summary IS NULL" via metadata_json filter on the read side.
//
// Cron-driven (target added to cron-dispatcher allowlist; scheduled
// every 5 minutes — outbound volume is lower than inbound).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const BATCH_SIZE = 25;
const SUMMARY_VERSION = "outbound_summary/v1";

interface OutboundRow {
  id: string;
  lead_id: string | null;
  subject: string | null;
  snippet_text: string | null;
  metadata_json: Record<string, unknown> | null;
}

function buildEmailText(row: OutboundRow): string {
  const subject = (row.subject ?? "").trim();
  const snippet = (row.snippet_text ?? "").trim();
  const lines: string[] = [];
  if (subject) lines.push(`Subject: ${subject}`);
  if (snippet) {
    if (lines.length > 0) lines.push("");
    lines.push(snippet);
  }
  return lines.join("\n");
}

async function summarize(emailText: string): Promise<string | null> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return null;
  const prompt = `Summarize this OUTBOUND sales email we sent to a prospect in 1-2 sentences. Capture the key ask, commitment, or offer. No preamble, no quotes — just the summary.

${emailText}`;

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) { await res.text(); return null; }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content?.trim() ?? "";
    const cleaned = content.replace(/^["']|["']$/g, "");
    return cleaned.length > 0 ? cleaned.slice(0, 500) : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const startedAt = Date.now();
  let fetched = 0, summarized = 0, failed = 0, skipped = 0;

  try {
    // Fetch outbound rows missing ai_summary, snippet present, oldest first
    // (so the about-to-purge ones get summarized before purge).
    const { data: rows, error } = await admin
      .from("lead_timeline_items")
      .select("id, lead_id, subject, snippet_text, metadata_json")
      .eq("event_type", "email_outbound")
      .not("snippet_text", "is", null)
      .order("occurred_at", { ascending: true })
      .limit(BATCH_SIZE * 4); // overfetch — many will already have summary

    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const candidates = ((rows ?? []) as OutboundRow[]).filter(r => {
      const sum = r.metadata_json?.ai_summary;
      return !(typeof sum === "string" && sum.trim().length > 0);
    }).slice(0, BATCH_SIZE);

    fetched = candidates.length;

    for (const row of candidates) {
      const emailText = buildEmailText(row);
      if (!emailText) { skipped++; continue; }

      const summary = await summarize(supabaseUrl, serviceKey, emailText);
      if (!summary) { failed++; continue; }

      const nextMeta = { ...(row.metadata_json ?? {}), ai_summary: summary, ai_summary_version: SUMMARY_VERSION };
      const { error: updErr } = await admin
        .from("lead_timeline_items")
        .update({ metadata_json: nextMeta, updated_at: new Date().toISOString() })
        .eq("id", row.id);

      if (updErr) { failed++; continue; }
      summarized++;
    }

    return new Response(
      JSON.stringify({ ok: true, fetched, summarized, failed, skipped, duration_ms: Date.now() - startedAt }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ ok: false, error: msg, fetched, summarized, failed, skipped }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
