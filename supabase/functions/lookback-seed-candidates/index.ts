// ============================================================
// lookback-seed-candidates — One-shot retroactive scan per mailbox
//
// When a Gmail connection or Outlook mail_account is first connected,
// `lookback_seed_completed_at` starts NULL. This worker (cron, hourly)
// finds those accounts, scans the last N days of SENT mail (default 30,
// per `workspaces.lookback_seed_window_days`), applies the same filter
// chain as detect-lead-candidates, and inserts pending candidates with
// source = 'lookback_seed'. On success, sets the completion timestamp
// so the account is never re-scanned.
//
// Bounded by:
//   - MAX_ACCOUNTS_PER_RUN = 3   (multiple accounts share the cron tick)
//   - MAX_MESSAGES_PER_ACCOUNT = 250 (cap so a single mailbox can't
//     exhaust the 55-second cron-dispatcher window)
//
// Auth: X-Internal-Secret (cron-dispatcher) OR service-role.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeDecryptToken, encryptToken } from "../_shared/encryption.ts";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";
import {
  normalizeEmail,
  emailDomain,
  extractEmailsFromHeader,
  extractNameFromHeader,
  applyOutboundFilter,
  makeSnippet,
  WorkspaceFilterContext,
} from "../_shared/leadCandidateDetection.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ACCOUNTS_PER_RUN = 3;
const MAX_MESSAGES_PER_ACCOUNT = 250;
const METADATA_BATCH_SIZE = 10;
const MASS_SEND_THRESHOLD = 10;
const GMAIL_PAGE_SIZE = 100;
const OUTLOOK_PAGE_SIZE = 100;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── Helpers ─────────────────────────────────────────────────

function gmailGetHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function formatGmailDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// ── Gmail token refresh (duplicated from detect-lead-candidates; small enough) ──

// deno-lint-ignore no-explicit-any
async function gmailRefreshToken(serviceSupabase: any, conn: {
  user_id: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string;
}): Promise<string> {
  const expiresAt = new Date(conn.token_expires_at);
  const decryptedAccess = await safeDecryptToken(conn.access_token_encrypted ?? "");
  const decryptedRefresh = await safeDecryptToken(conn.refresh_token_encrypted ?? "");

  if (expiresAt.getTime() - Date.now() >= 5 * 60 * 1000) {
    return decryptedAccess;
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decryptedRefresh,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gmail token refresh failed (${resp.status}): ${body.slice(0, 200)}`);
  }

  const tokens = await resp.json();
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const hasKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
  const encryptedAccess = hasKey ? await encryptToken(tokens.access_token) : tokens.access_token;

  await serviceSupabase
    .from("gmail_connections")
    .update({ access_token_encrypted: encryptedAccess, token_expires_at: newExpiresAt })
    .eq("user_id", conn.user_id);

  return tokens.access_token;
}

// ── Filter context loader (mirrors detect-lead-candidates) ──

// deno-lint-ignore no-explicit-any
async function loadFilterContext(
  serviceSupabase: any,
  workspaceId: string,
  repEmail: string,
): Promise<WorkspaceFilterContext> {
  const repDomain = emailDomain(repEmail);

  const [
    { data: gmailConns },
    { data: outlookAccounts },
    { data: internalDomainRows },
    { data: dismissedEmailRows },
    { data: dismissedDomainRows },
    { data: leadRows },
  ] = await Promise.all([
    serviceSupabase
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .then(({ data: members }: { data: Array<{ user_id: string }> | null }) => {
        if (!members || members.length === 0) return { data: [] };
        return serviceSupabase
          .from("gmail_connections")
          .select("gmail_email")
          .in("user_id", members.map(m => m.user_id));
      }),
    serviceSupabase
      .from("mail_accounts")
      .select("email_address")
      .eq("workspace_id", workspaceId)
      .eq("provider", "outlook"),
    serviceSupabase
      .from("workspace_internal_domains")
      .select("domain")
      .eq("workspace_id", workspaceId),
    serviceSupabase
      .from("workspace_dismissed_emails")
      .select("email")
      .eq("workspace_id", workspaceId),
    serviceSupabase
      .from("workspace_dismissed_domains")
      .select("domain")
      .eq("workspace_id", workspaceId),
    serviceSupabase
      .from("leads")
      .select("email")
      .eq("workspace_id", workspaceId)
      .not("email", "is", null),
  ]);

  const memberEmails = new Set<string>();
  for (const r of gmailConns ?? []) memberEmails.add(r.gmail_email.toLowerCase().trim());
  for (const r of outlookAccounts ?? []) memberEmails.add(r.email_address.toLowerCase().trim());

  const internalDomains = new Set<string>([repDomain]);
  for (const r of internalDomainRows ?? []) internalDomains.add(r.domain.toLowerCase().trim());

  const dismissedEmails = new Set<string>();
  for (const r of dismissedEmailRows ?? []) dismissedEmails.add(normalizeEmail(r.email));

  const dismissedDomains = new Set<string>();
  for (const r of dismissedDomainRows ?? []) dismissedDomains.add(r.domain.toLowerCase().trim());

  const existingLeadEmails = new Set<string>();
  for (const r of leadRows ?? []) {
    if (r.email) existingLeadEmails.add(normalizeEmail(r.email));
  }

  return { workspaceId, memberEmails, internalDomains, dismissedEmails, dismissedDomains, existingLeadEmails };
}

// ── Candidate upsert (lookback always inserts pending; never updates existing rows) ──

// deno-lint-ignore no-explicit-any
async function upsertLookbackCandidate(serviceSupabase: any, args: {
  workspaceId: string;
  ownerUserId: string | null;
  contactEmail: string;
  contactName: string | null;
  companyDomain: string | null;
  emailDate: Date;
  subjectSnippet: string;
  bodySnippet: string;
}): Promise<"inserted" | "skipped"> {
  const normalized = normalizeEmail(args.contactEmail);

  // Skip if any candidate already exists — including approved.
  // Lookback is one-shot: we never bump email_count, re-surface approved leads,
  // or compete with detect-lead-candidates on pending/snoozed/dismissed rows.
  const { data: existing } = await serviceSupabase
    .from("lead_candidates")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .eq("contact_email", normalized)
    .limit(1)
    .maybeSingle();

  if (existing) return "skipped";

  const { error } = await serviceSupabase.from("lead_candidates").insert({
    workspace_id: args.workspaceId,
    owner_user_id: args.ownerUserId,
    contact_email: normalized,
    contact_name: args.contactName,
    company_domain: args.companyDomain,
    source: "lookback_seed",
    first_seen_at: args.emailDate.toISOString(),
    last_email_at: args.emailDate.toISOString(),
    email_count: 1,
    subject_snippet: args.subjectSnippet,
    body_snippet: args.bodySnippet,
    status: "pending",
  });

  if (error) {
    if (error.code === "23505") return "skipped"; // race against partial unique index
    throw error;
  }
  return "inserted";
}

// ── Gmail SENT scan with pagination ──

// deno-lint-ignore no-explicit-any
async function scanGmailLookback(
  serviceSupabase: any,
  conn: { user_id: string; gmail_email: string },
  accessToken: string,
  workspaceId: string,
  ctx: WorkspaceFilterContext,
  windowDays: number,
): Promise<{ inserted: number; skipped: number; messages: number }> {
  const repEmail = conn.gmail_email.toLowerCase().trim();
  const since = new Date();
  since.setDate(since.getDate() - windowDays);
  const sinceMs = since.getTime();
  const sinceStr = formatGmailDate(since);
  const stats = { inserted: 0, skipped: 0, messages: 0 };

  let pageToken: string | undefined = undefined;

  while (stats.messages < MAX_MESSAGES_PER_ACCOUNT) {
    const params = new URLSearchParams({
      q: `in:sent after:${sinceStr}`,
      maxResults: String(GMAIL_PAGE_SIZE),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const listResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!listResp.ok) {
      const err = await listResp.text();
      throw new Error(`Gmail list failed (${listResp.status}): ${err.slice(0, 200)}`);
    }
    const listData = await listResp.json();
    const ids: string[] = (listData.messages ?? []).map((m: { id: string }) => m.id);
    pageToken = listData.nextPageToken;

    if (ids.length === 0) break;

    // Fetch metadata in parallel batches
    for (let i = 0; i < ids.length; i += METADATA_BATCH_SIZE) {
      if (stats.messages >= MAX_MESSAGES_PER_ACCOUNT) break;
      const batch = ids.slice(i, i + METADATA_BATCH_SIZE);

      const metaResults = await Promise.all(batch.map(id =>
        fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ).then(r => r.ok ? r.json() : null).catch(() => null)
      ));

      for (const msg of metaResults) {
        if (!msg) continue;
        stats.messages++;
        try {
          const internalDate = parseInt(msg.internalDate ?? "0");
          if (internalDate < sinceMs) continue;

          const headers: Array<{ name: string; value: string }> = msg.payload?.headers ?? [];
          const from = gmailGetHeader(headers, "From");
          const toRaw = gmailGetHeader(headers, "To");
          const ccRaw = gmailGetHeader(headers, "Cc");
          const subject = gmailGetHeader(headers, "Subject") || "(no subject)";
          const dateHeader = gmailGetHeader(headers, "Date");
          const emailDate = dateHeader ? new Date(dateHeader) : new Date(internalDate);
          const snippet = makeSnippet(msg.snippet ?? "");

          const fromEmails = extractEmailsFromHeader(from);
          if (!fromEmails.includes(repEmail)) continue;

          const allTo = [
            ...extractEmailsFromHeader(toRaw),
            ...extractEmailsFromHeader(ccRaw),
          ];
          const external = allTo.filter(e => applyOutboundFilter(e, ctx).pass);
          if (external.length > MASS_SEND_THRESHOLD) continue;

          for (const recipEmail of external) {
            const recipName = allTo.length === 1 ? extractNameFromHeader(toRaw) : null;
            const action = await upsertLookbackCandidate(serviceSupabase, {
              workspaceId,
              ownerUserId: conn.user_id,
              contactEmail: recipEmail,
              contactName: recipName,
              companyDomain: emailDomain(recipEmail) || null,
              emailDate,
              subjectSnippet: makeSnippet(subject, 200),
              bodySnippet: snippet,
            });
            stats[action]++;
          }
        } catch (err) {
          console.error(`[lookback-seed-candidates] Gmail msg error:`, err);
        }
      }
    }

    if (!pageToken) break;
  }

  return stats;
}

// ── Outlook SENT scan with pagination ──

// deno-lint-ignore no-explicit-any
async function scanOutlookLookback(
  serviceSupabase: any,
  account: { id: string; workspace_id: string; email_address: string },
  accessToken: string,
  ctx: WorkspaceFilterContext,
  windowDays: number,
): Promise<{ inserted: number; skipped: number; messages: number }> {
  const repEmail = account.email_address.toLowerCase().trim();
  const since = new Date();
  since.setDate(since.getDate() - windowDays);
  const filterDate = since.toISOString();
  const stats = { inserted: 0, skipped: 0, messages: 0 };

  let nextUrl: string | null =
    `${GRAPH_BASE}/me/mailFolders/sentItems/messages` +
    `?$filter=sentDateTime ge ${filterDate}` +
    `&$top=${OUTLOOK_PAGE_SIZE}` +
    `&$orderby=sentDateTime desc` +
    `&$select=id,subject,bodyPreview,from,toRecipients,ccRecipients,sentDateTime`;

  while (nextUrl && stats.messages < MAX_MESSAGES_PER_ACCOUNT) {
    const resp = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: "eventual" },
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Outlook sentItems failed (${resp.status}): ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    const messages = data.value ?? [];

    for (const msg of messages) {
      if (stats.messages >= MAX_MESSAGES_PER_ACCOUNT) break;
      stats.messages++;
      try {
        const emailDate = new Date(msg.sentDateTime);
        const subject = msg.subject || "(no subject)";
        const snippet = makeSnippet(msg.bodyPreview ?? "");

        const fromEmail = msg.from?.emailAddress?.address?.toLowerCase().trim() ?? "";
        if (fromEmail !== repEmail) continue;

        const allTo: string[] = [
          ...(msg.toRecipients ?? []).map((r: { emailAddress: { address: string } }) =>
            r.emailAddress?.address?.toLowerCase().trim()).filter(Boolean),
          ...(msg.ccRecipients ?? []).map((r: { emailAddress: { address: string } }) =>
            r.emailAddress?.address?.toLowerCase().trim()).filter(Boolean),
        ];
        const external = allTo.filter(e => applyOutboundFilter(e, ctx).pass);
        if (external.length > MASS_SEND_THRESHOLD) continue;

        for (const recipEmail of external) {
          const recipName =
            allTo.length === 1
              ? (msg.toRecipients?.[0]?.emailAddress?.name ?? null)
              : null;
          const action = await upsertLookbackCandidate(serviceSupabase, {
            workspaceId: account.workspace_id,
            ownerUserId: null,
            contactEmail: recipEmail,
            contactName: recipName,
            companyDomain: emailDomain(recipEmail) || null,
            emailDate,
            subjectSnippet: makeSnippet(subject, 200),
            bodySnippet: snippet,
          });
          stats[action]++;
        }
      } catch (err) {
        console.error(`[lookback-seed-candidates] Outlook msg error:`, err);
      }
    }

    nextUrl = data["@odata.nextLink"] ?? null;
  }

  return stats;
}

// ── Main handler ─────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // deno-lint-ignore no-explicit-any
  const serviceSupabase: any = createClient(supabaseUrl, supabaseServiceKey);

  const startedAt = Date.now();
  let processedCount = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalMessages = 0;
  const errors: string[] = [];

  // ── Pick up to MAX_ACCOUNTS_PER_RUN accounts needing seeding ──
  const { data: pendingGmail } = await serviceSupabase
    .from("gmail_connections")
    .select("user_id, gmail_email, access_token_encrypted, refresh_token_encrypted, token_expires_at")
    .is("lookback_seed_completed_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_ACCOUNTS_PER_RUN);

  for (const conn of pendingGmail ?? []) {
    if (processedCount >= MAX_ACCOUNTS_PER_RUN) break;
    try {
      const { data: membership } = await serviceSupabase
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", conn.user_id)
        .limit(1)
        .maybeSingle();

      if (!membership) {
        // Mark complete to stop retrying — no workspace means we cannot scope leads anyway
        await serviceSupabase
          .from("gmail_connections")
          .update({ lookback_seed_completed_at: new Date().toISOString() })
          .eq("user_id", conn.user_id);
        continue;
      }

      const workspaceId = membership.workspace_id;
      const { data: workspace } = await serviceSupabase
        .from("workspaces")
        .select("lookback_seed_window_days")
        .eq("id", workspaceId)
        .single();
      const windowDays = workspace?.lookback_seed_window_days ?? 30;

      const ctx = await loadFilterContext(serviceSupabase, workspaceId, conn.gmail_email);
      const accessToken = await gmailRefreshToken(serviceSupabase, conn);
      const stats = await scanGmailLookback(serviceSupabase, conn, accessToken, workspaceId, ctx, windowDays);

      totalInserted += stats.inserted;
      totalSkipped += stats.skipped;
      totalMessages += stats.messages;

      await serviceSupabase
        .from("gmail_connections")
        .update({ lookback_seed_completed_at: new Date().toISOString() })
        .eq("user_id", conn.user_id);

      processedCount++;
      console.log(
        `[lookback-seed-candidates] Gmail ${conn.gmail_email}: scanned ${stats.messages} msgs over ${windowDays}d, +${stats.inserted} new, ${stats.skipped} skipped`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[lookback-seed-candidates] Gmail ${conn.gmail_email} error:`, msg);
      errors.push(`Gmail ${conn.gmail_email}: ${msg.slice(0, 200)}`);
      // Don't mark complete — will retry next run
    }
  }

  // Outlook accounts
  if (processedCount < MAX_ACCOUNTS_PER_RUN) {
    const { data: pendingOutlook } = await serviceSupabase
      .from("mail_accounts")
      .select("id, workspace_id, email_address")
      .eq("provider", "outlook")
      .eq("status", "connected")
      .is("lookback_seed_completed_at", null)
      .order("created_at", { ascending: true })
      .limit(MAX_ACCOUNTS_PER_RUN - processedCount);

    for (const account of pendingOutlook ?? []) {
      if (processedCount >= MAX_ACCOUNTS_PER_RUN) break;
      try {
        const { data: workspace } = await serviceSupabase
          .from("workspaces")
          .select("lookback_seed_window_days")
          .eq("id", account.workspace_id)
          .single();
        const windowDays = workspace?.lookback_seed_window_days ?? 30;

        const ctx = await loadFilterContext(serviceSupabase, account.workspace_id, account.email_address);
        const accessToken = await getFreshOutlookToken(account.id, serviceSupabase);
        const stats = await scanOutlookLookback(serviceSupabase, account, accessToken, ctx, windowDays);

        totalInserted += stats.inserted;
        totalSkipped += stats.skipped;
        totalMessages += stats.messages;

        await serviceSupabase
          .from("mail_accounts")
          .update({ lookback_seed_completed_at: new Date().toISOString() })
          .eq("id", account.id);

        processedCount++;
        console.log(
          `[lookback-seed-candidates] Outlook ${account.email_address}: scanned ${stats.messages} msgs over ${windowDays}d, +${stats.inserted} new, ${stats.skipped} skipped`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[lookback-seed-candidates] Outlook ${account.email_address} error:`, msg);
        errors.push(`Outlook ${account.email_address}: ${msg.slice(0, 200)}`);
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[lookback-seed-candidates] Done in ${durationMs}ms — accounts:${processedCount} msgs:${totalMessages} inserted:${totalInserted} skipped:${totalSkipped} errors:${errors.length}`,
  );

  return new Response(
    JSON.stringify({
      ok: true,
      accounts_processed: processedCount,
      messages_scanned: totalMessages,
      inserted: totalInserted,
      skipped: totalSkipped,
      duration_ms: durationMs,
      errors: errors.length > 0 ? errors : undefined,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
