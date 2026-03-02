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
    // Any response (including 400 validation) means the function is reachable
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
];

export async function runAllSmokeTests(): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  for (const t of smokeTests) {
    results.push(await t.run());
  }
  return results;
}
