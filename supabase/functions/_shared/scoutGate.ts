// ============================================================
// scoutGate — shared request plumbing for the scout-* edge functions.
//
// Every Scout request: user JWT → workspace membership → master switch
// (workspace_automation_settings.scout_enabled, read with the service role).
// Missing row, missing column (prod before the Unit 1 migration) or any read
// error = "not enabled": a clean { ok:false, reason:"not_enabled" }, never a 500.
// Deno-only (creates clients); NOT imported from src/.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertWorkspaceMembership, resolveUser } from "./authz.ts";

// deno-lint-ignore no-explicit-any
export type AdminClient = any; // ponytail: no generated Database type in _shared; scout tables aren't in types.ts yet.

export const scoutCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export function scoutJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...scoutCors, "Content-Type": "application/json" } });
}

export interface ScoutRequest {
  admin: AdminClient;
  userId: string;
  workspaceId: string;
  body: Record<string, unknown>;
  settings: { scout_weekly_cap: number; scout_allow_eu: boolean };
}

export async function openScoutRequest(req: Request): Promise<ScoutRequest | Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: scoutCors });
  const user = await resolveUser(req);
  if (!user) return scoutJson({ ok: false, error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.workspace_id !== "string") {
    return scoutJson({ ok: false, error: "workspace_id is required" }, 400);
  }
  const admin: AdminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const member = await assertWorkspaceMembership(admin, body.workspace_id, user.userId);
  if (!member.ok) return scoutJson({ ok: false, error: member.error }, member.status ?? 403);

  const { data, error } = await admin
    .from("workspace_automation_settings")
    .select("scout_enabled, scout_weekly_cap, scout_allow_eu")
    .eq("workspace_id", body.workspace_id)
    .maybeSingle();
  if (error || data?.scout_enabled !== true) return scoutJson({ ok: false, reason: "not_enabled" });

  return {
    admin,
    userId: user.userId,
    workspaceId: body.workspace_id,
    body,
    settings: { scout_weekly_cap: data.scout_weekly_cap ?? 0, scout_allow_eu: data.scout_allow_eu === true },
  };
}

/** The caller's own scout profile row (any status), or null. */
export async function ownedProfileId(r: ScoutRequest, profileId: unknown): Promise<string | null> {
  if (typeof profileId !== "string") return null;
  const { data } = await r.admin
    .from("scout_profiles")
    .select("id")
    .eq("id", profileId)
    .eq("workspace_id", r.workspaceId)
    .eq("owner_user_id", r.userId)
    .maybeSingle();
  return data?.id ?? null;
}

/** id → company (or name) for the caller's own leads among `ids`. Unknown ids are absent. */
export async function anchorNames(r: ScoutRequest, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data } = await r.admin
    .from("leads")
    .select("id, name, company")
    .in("id", ids.slice(0, 10))
    .eq("workspace_id", r.workspaceId)
    .eq("owner_user_id", r.userId);
  return Object.fromEntries((data ?? []).map((l: { id: string; name: string; company: string }) => [l.id, l.company || l.name]));
}

/** One scout_* task through ai_task (service role). Returns the parsed result or null. */
export async function callScoutAi(task: string, payload: unknown): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ai_task`, {
      method: "POST",
      signal: AbortSignal.timeout(55_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ task, payload }),
    });
    const json = await res.json().catch(() => null);
    return res.ok && json?.ok && json.result && typeof json.result === "object" ? json.result : null;
  } catch (e) {
    console.error(`[scout] ${task} call failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}
