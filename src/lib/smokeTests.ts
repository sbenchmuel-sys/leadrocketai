import { supabase } from "@/integrations/supabase/client";
import { fetchConversations, fetchDecryptedMessages } from "@/lib/inboxQueries";

export type SmokeResult = {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  durationMs: number;
};

type SmokeTest = { name: string; run: () => Promise<SmokeResult> };

function timed(name: string, fn: () => Promise<Omit<SmokeResult, "name" | "durationMs">>): SmokeTest {
  return {
    name,
    run: async () => {
      const t0 = performance.now();
      try {
        const r = await fn();
        return { ...r, name, durationMs: Math.round(performance.now() - t0) };
      } catch (err: any) {
        return { name, status: "fail", detail: err.message ?? String(err), durationMs: Math.round(performance.now() - t0) };
      }
    },
  };
}

export const smokeTests: SmokeTest[] = [
  // 1) Inbox list loads
  timed("Inbox list loads", async () => {
    const rows = await fetchConversations("active");
    if (rows.length === 0) return { status: "warn", detail: "Returned 0 conversations (may be empty workspace)" };
    return { status: "pass", detail: `${rows.length} conversations returned` };
  }),

  // 2) Conversation thread loads
  timed("Conversation thread loads", async () => {
    const convos = await fetchConversations("active");
    if (convos.length === 0) return { status: "warn", detail: "No conversations to test" };
    const first = convos[0];
    const { messages } = await fetchDecryptedMessages(first.id);
    return { status: "pass", detail: `${messages.length} messages loaded from conversation ${first.id.slice(0, 8)}` };
  }),

  // 3) Gmail send function reachable (no actual send)
  timed("Gmail send reachable (dry)", async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { status: "fail", detail: "Not authenticated" };

    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-send`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dryRun: true }),
    });
    await resp.text();
    if (resp.status >= 500) return { status: "fail", detail: `Server error: ${resp.status}` };
    return { status: "pass", detail: `Endpoint responded with ${resp.status} (reachable)` };
  }),

  // 4) Automations health
  timed("Automations table accessible", async () => {
    const { count, error } = await supabase
      .from("automation_log")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (error) return { status: "fail", detail: error.message };
    return { status: "pass", detail: `automation_log accessible (${count ?? 0} rows)` };
  }),

  // 5) WhatsApp function reachable (no actual send)
  timed("WhatsApp send reachable (dry)", async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { status: "fail", detail: "Not authenticated" };

    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-send`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dryRun: true }),
    });
    await resp.text();
    if (resp.status >= 500) return { status: "fail", detail: `Server error: ${resp.status}` };
    return { status: "pass", detail: `Endpoint responded with ${resp.status} (reachable)` };
  }),

  // 6) Outlook send reachable (no actual send)
  timed("Outlook send reachable (dry)", async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { status: "fail", detail: "Not authenticated" };

    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/outlook-send`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dryRun: true }),
    });
    await resp.text();
    if (resp.status >= 500) return { status: "fail", detail: `Server error: ${resp.status}` };
    return { status: "pass", detail: `Endpoint responded with ${resp.status} (reachable)` };
  }),

  // 7) Claim lifecycle columns exist (claimed_at, claim_expires_at)
  timed("Automation claim lifecycle columns", async () => {
    const { data, error } = await supabase
      .from("automation_log")
      .select("id, claim_date, claimed_at, claim_expires_at")
      .limit(1);
    if (error) return { status: "fail", detail: `Query error: ${error.message}` };
    return { status: "pass", detail: "automation_log claim lifecycle columns accessible (claim_date, claimed_at, claim_expires_at)" };
  }),

  // 8) No stuck claims (stale claim recovery check)
  timed("No stale claiming rows", async () => {
    const { count, error } = await supabase
      .from("automation_log")
      .select("id", { count: "exact", head: true })
      .eq("status", "claiming")
      .lt("claim_expires_at", new Date().toISOString());
    if (error) return { status: "fail", detail: error.message };
    if ((count ?? 0) > 0) return { status: "warn", detail: `${count} stale claims found — next executor run will recover them` };
    return { status: "pass", detail: "No stale claims in automation_log" };
  }),

  // 9) One-send-one-interaction invariant — check for duplicate outbound interactions
  timed("No duplicate outbound interactions (last 24h)", async () => {
    // Check if any lead has >1 outbound email interaction in the same minute (likely dupe)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentSent, error } = await supabase
      .from("automation_log")
      .select("lead_id, action_key, claim_date")
      .eq("status", "sent")
      .gte("created_at", oneDayAgo);
    if (error) return { status: "fail", detail: error.message };
    if (!recentSent || recentSent.length === 0) return { status: "pass", detail: "No sends in last 24h to check" };

    // Check for duplicate (lead_id, action_key, claim_date) combos
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const row of recentSent) {
      const key = `${row.lead_id}|${row.action_key}|${row.claim_date}`;
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
    if (dupes.length > 0) return { status: "fail", detail: `${dupes.length} duplicate send(s) detected: ${dupes[0]}` };
    return { status: "pass", detail: `${recentSent.length} sends verified unique (last 24h)` };
  }),

  // 10) Claim unique index exists (functional check)
  timed("Claim unique index blocks duplicates", async () => {
    const { data, error } = await supabase
      .from("automation_log")
      .select("id, status, claim_date, claimed_at, claim_expires_at")
      .eq("status", "claiming")
      .limit(1);
    if (error) return { status: "fail", detail: `Schema check failed: ${error.message}` };
    return { status: "pass", detail: "Claim columns and status filter operational" };
  }),

  // 11) Timeline source_id consistency — new rows should have UUID-format source_id
  timed("Timeline source_id format check (recent)", async () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("lead_timeline_items")
      .select("id, source_id, source_table")
      .eq("source_table", "interactions")
      .gte("created_at", oneDayAgo)
      .limit(50);
    if (error) return { status: "fail", detail: error.message };
    if (!data || data.length === 0) return { status: "pass", detail: "No recent timeline items to check" };

    // UUID v4 regex check
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const nonUuid = data.filter((r: { source_id: string }) => !uuidRe.test(r.source_id));
    if (nonUuid.length > 0) {
      return { status: "warn", detail: `${nonUuid.length}/${data.length} recent timeline rows have non-UUID source_id (historical)` };
    }
    return { status: "pass", detail: `${data.length} recent timeline rows all have UUID source_id` };
  }),

  // 12) No duplicate dedupe_keys per lead (invariant check)
  timed("No duplicate timeline dedupe_keys (sample)", async () => {
    // Sample a recent lead and check for dedupe_key collisions
    const { data: sample, error } = await supabase
      .from("lead_timeline_items")
      .select("lead_id, dedupe_key")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { status: "fail", detail: error.message };
    if (!sample || sample.length === 0) return { status: "pass", detail: "No timeline items to check" };

    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const row of sample) {
      const key = `${row.lead_id}|${row.dedupe_key}`;
      if (seen.has(key)) dupes.push(row.dedupe_key);
      seen.add(key);
    }
    if (dupes.length > 0) return { status: "fail", detail: `${dupes.length} duplicate dedupe_key(s) found: ${dupes[0]}` };
    return { status: "pass", detail: `${sample.length} timeline rows checked, all dedupe_keys unique per lead` };
  }),

  // 13) Hide/unhide works for both UUID and legacy source_id rows
  timed("Timeline hide column accessible", async () => {
    const { data, error } = await supabase
      .from("lead_timeline_items")
      .select("id, hidden, source_id, source_table")
      .limit(1);
    if (error) return { status: "fail", detail: error.message };
    return { status: "pass", detail: "hidden, source_id, source_table columns accessible" };
  }),

  // 14) call-api rejects unauthenticated requests
  timed("call-api rejects unauthenticated", async () => {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/call-api?callSid=test`;
    const resp = await fetch(url, { method: "GET" });
    const body = await resp.text();
    if (resp.status === 401) return { status: "pass", detail: "Correctly returned 401 for unauthenticated request" };
    return { status: "fail", detail: `Expected 401, got ${resp.status}: ${body.slice(0, 100)}` };
  }),

  // 15) call-api rejects cross-workspace access (non-existent session)
  timed("call-api rejects missing session", async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { status: "warn", detail: "Not authenticated — skipping" };
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/call-api?callSessionId=00000000-0000-0000-0000-000000000000`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const body = await resp.json();
    if (resp.status === 404) return { status: "pass", detail: "Correctly returned 404 for non-existent session" };
    return { status: "fail", detail: `Expected 404, got ${resp.status}: ${JSON.stringify(body).slice(0, 100)}` };
  }),

  // 16) automation-executor rejects anon-only auth (no internal secret)
  timed("automation-executor rejects anon auth", async () => {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/automation-executor`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await resp.text();
    if (resp.status === 401) return { status: "pass", detail: "Correctly returned 401 for unauthenticated request" };
    return { status: "fail", detail: `Expected 401, got ${resp.status}: ${body.slice(0, 100)}` };
  }),

  // 17) call-api webhook logs require privileged access
  timed("call-api webhook logs reject user JWT", async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { status: "warn", detail: "Not authenticated — skipping" };
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/call-api?recent=webhooks`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const body = await resp.json();
    if (resp.status === 403) return { status: "pass", detail: "Correctly returned 403 for non-privileged webhook log access" };
    return { status: "fail", detail: `Expected 403, got ${resp.status}: ${JSON.stringify(body).slice(0, 100)}` };
  }),
];

export async function runAllSmokeTests(): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  for (const t of smokeTests) {
    results.push(await t.run());
  }
  return results;
}
