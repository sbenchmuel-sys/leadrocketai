// ============================================================
// Call Channel — Query helpers for frontend
// ============================================================
import { supabase } from "@/integrations/supabase/client";
import type { FullCallSession, CallSession } from "./callTypes";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

async function callApi(params: Record<string, string>): Promise<unknown> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");

  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/call-api?${qs}`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Call API error: ${text}`);
  }

  return resp.json();
}

export async function fetchCallByCallSid(callSid: string): Promise<FullCallSession> {
  const result = await callApi({ callSid }) as { ok: boolean } & FullCallSession;
  return result;
}

export async function fetchCallBySessionId(id: string): Promise<FullCallSession> {
  const result = await callApi({ callSessionId: id }) as { ok: boolean } & FullCallSession;
  return result;
}

export async function fetchCallsByLeadId(leadId: string): Promise<CallSession[]> {
  const result = await callApi({ leadId }) as { ok: boolean; sessions: CallSession[] };
  return result.sessions;
}

export async function fetchRecentWebhookLog(): Promise<unknown[]> {
  const result = await callApi({ recent: "webhooks" }) as { ok: boolean; webhooks: unknown[] };
  return result.webhooks;
}
