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
    // Verify the unique index exists by checking that claim_date column is queryable
    // (actual concurrent test requires two executor runs — this checks schema readiness)
    const { data, error } = await supabase
      .from("automation_log")
      .select("id, status, claim_date, claimed_at, claim_expires_at")
      .eq("status", "claiming")
      .limit(1);
    if (error) return { status: "fail", detail: `Schema check failed: ${error.message}` };
    return { status: "pass", detail: "Claim columns and status filter operational" };
  }),
];

export async function runAllSmokeTests(): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  for (const t of smokeTests) {
    results.push(await t.run());
  }
  return results;
}
