// ============================================================
// routing.ts — resolve Meta webhook payload → workspace_id
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface RouteResult {
  workspaceId: string | null;
  integrationId: string | null;
  ownerUserId: string | null;
}

/**
 * Resolve workspace from a Meta phone_number_id.
 * Returns null workspace if no matching active integration found.
 */
export async function resolveWorkspaceByPhoneNumberId(
  phoneNumberId: string,
): Promise<RouteResult> {
  if (!phoneNumberId) {
    console.warn("[routing] No phone_number_id provided");
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
    .eq("provider_account_id", phoneNumberId)
    .maybeSingle();

  if (error) {
    console.error("[routing] DB error resolving integration:", error.message);
    return { workspaceId: null, integrationId: null, ownerUserId: null };
  }

  if (!integration) {
    console.warn(
      `[routing] No active whatsapp integration for phone_number_id=${phoneNumberId}`,
    );
    return { workspaceId: null, integrationId: null, ownerUserId: null };
  }

  return {
    workspaceId: integration.workspace_id,
    integrationId: integration.id,
    ownerUserId: integration.user_id,
  };
}
