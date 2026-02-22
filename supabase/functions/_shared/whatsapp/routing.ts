// ============================================================
// routing.ts — resolve webhook payload → workspace_id
// Supports both Meta and Twilio providers with provider filter
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface RouteResult {
  workspaceId: string | null;
  integrationId: string | null;
  ownerUserId: string | null;
}

/**
 * Resolve workspace from a provider_account_id + provider.
 * Returns null workspace if no matching active integration found.
 */
export async function resolveWorkspace(
  providerAccountId: string,
  provider: "meta" | "twilio",
): Promise<RouteResult> {
  if (!providerAccountId) {
    console.warn("[routing] No providerAccountId provided");
    return { workspaceId: null, integrationId: null, ownerUserId: null };
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: integration, error } = await supabase
    .from("integrations")
    .select("id, workspace_id, user_id")
    .eq("type", "whatsapp")
    .eq("is_active", true)
    .eq("provider", provider)
    .eq("provider_account_id", providerAccountId)
    .maybeSingle();

  if (error) {
    console.error("[routing] DB error resolving integration:", error.message);
    return { workspaceId: null, integrationId: null, ownerUserId: null };
  }

  if (!integration) {
    console.warn(
      `[routing] No active whatsapp integration for provider=${provider} account_id=${providerAccountId}`,
    );
    return { workspaceId: null, integrationId: null, ownerUserId: null };
  }

  return {
    workspaceId: integration.workspace_id,
    integrationId: integration.id,
    ownerUserId: integration.user_id,
  };
}

/**
 * @deprecated Use resolveWorkspace(id, "meta") instead.
 */
export async function resolveWorkspaceByPhoneNumberId(
  phoneNumberId: string,
): Promise<RouteResult> {
  return resolveWorkspace(phoneNumberId, "meta");
}
