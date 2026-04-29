// One-off probe: inspect Shai's Gmail sent items + filter outcomes
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeDecryptToken } from "../_shared/encryption.ts";
import {
  normalizeEmail, emailDomain, extractEmailsFromHeader,
  applyOutboundFilter,
} from "../_shared/leadCandidateDetection.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb: any = createClient(url, key);

  const targetEmail = "shai.benchmuel@binah.ai";
  const { data: conn } = await sb.from("gmail_connections")
    .select("user_id, gmail_email, access_token_encrypted, refresh_token_encrypted, token_expires_at")
    .eq("gmail_email", targetEmail).single();

  // Refresh token
  const refresh = await safeDecryptToken(conn.refresh_token_encrypted);
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refresh, grant_type: "refresh_token",
    }),
  });
  const tokens = await tr.json();
  const accessToken = tokens.access_token;
  if (!accessToken) return new Response(JSON.stringify({ error: "no token", tokens }), { headers: corsHeaders });

  const { data: wm } = await sb.from("workspace_members")
    .select("workspace_id").eq("user_id", conn.user_id).limit(1).single();
  const workspaceId = wm.workspace_id;

  // Build filter ctx
  const { data: leadRows } = await sb.from("leads").select("email").eq("workspace_id", workspaceId).not("email","is",null);
  const existingLeadEmails = new Set<string>();
  for (const r of leadRows ?? []) if (r.email) existingLeadEmails.add(normalizeEmail(r.email));

  const ctx = {
    workspaceId,
    memberEmails: new Set([targetEmail.toLowerCase()]),
    internalDomains: new Set(["binah.ai"]),
    dismissedEmails: new Set<string>(),
    dismissedDomains: new Set<string>(),
    existingLeadEmails,
  };

  // List recent sent
  const since = new Date(); since.setDate(since.getDate()-30);
  const sinceStr = `${since.getFullYear()}/${String(since.getMonth()+1).padStart(2,"0")}/${String(since.getDate()).padStart(2,"0")}`;
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:sent after:${sinceStr}&maxResults=50`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  }).then(r => r.json());

  const ids = (list.messages ?? []).slice(0, 5).map((m:any)=>m.id);
  const dump: any[] = [];
  for (const id of ids) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From,To,Cc,Subject,Date`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const status = r.status;
    const msg = await r.json();
    dump.push({ id, status, error: msg.error, labelIds: msg.labelIds, snippet: (msg.snippet||"").slice(0,100), headers: msg.payload?.headers, payloadKeys: msg.payload ? Object.keys(msg.payload) : null });
  }
  return new Response(JSON.stringify({ scopes: tokens.scope, listCount: list.messages?.length, dump }, null, 2), { headers: { ...corsHeaders, "Content-Type":"application/json" } });
  // unreachable below
  const reasons: Record<string, number> = { passed:0, fromMismatch:0, internal:0, dismissed:0, existingLead:0, mass:0 };
  const samples: any[] = [];

  for (const id of [] as string[]) {
    const msg: any = {};
    const headers = msg.payload?.headers ?? [];
    const get = (n:string) => headers.find((h:any)=>h.name.toLowerCase()===n.toLowerCase())?.value ?? "";
    const from = get("From"), toRaw = get("To"), ccRaw = get("Cc");
    const fromEmails = extractEmailsFromHeader(from);
    if (!fromEmails.includes(targetEmail.toLowerCase())) {
      reasons.fromMismatch++;
      if (samples.length < 10) samples.push({ from, fromParsed: fromEmails, subject: get("Subject") });
      continue;
    }
    const allTo = [...extractEmailsFromHeader(toRaw), ...extractEmailsFromHeader(ccRaw)];
    if (allTo.length > 10) { reasons.mass++; continue; }
    for (const e of allTo) {
      const r = applyOutboundFilter(e, ctx);
      if (r.pass) { reasons.passed++; if (samples.length<10) samples.push({to:e, subject:get("Subject")}); }
      else reasons[r.reason as string] = (reasons[r.reason as string]||0)+1;
    }
  }

  return new Response(JSON.stringify({
    inspected: ids.length,
    workspaceId,
    existingLeadCount: existingLeadEmails.size,
    reasons,
    samplesPassed: samples,
    sampleExistingLeads: Array.from(existingLeadEmails).slice(0,5),
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
