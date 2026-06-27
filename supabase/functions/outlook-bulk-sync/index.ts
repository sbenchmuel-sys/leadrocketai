// ============================================================
// outlook-bulk-sync — Multi-lead Outlook sync
//
// Mirror of gmail-bulk-sync for the Outlook provider.
// Resolves the user's connected Outlook mail_account, then
// invokes outlook-sync once per lead. Returns a summary.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface PerLeadResult {
  leadId: string;
  synced: number;
  errors: string[];
  needsReconnect?: boolean;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { leadIds, maxResults = 20, workspace_id: requestedWorkspaceId } = await req.json();
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing or empty leadIds array" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);

    // Resolve workspace + connected Outlook mail_account
    let membershipQuery = supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1);
    if (typeof requestedWorkspaceId === "string" && requestedWorkspaceId.length > 0) {
      membershipQuery = membershipQuery.eq("workspace_id", requestedWorkspaceId);
    }
    const { data: membership } = await membershipQuery.maybeSingle();

    if (!membership) {
      return new Response(JSON.stringify({ ok: false, error: "No workspace found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: mailAccount } = await serviceSupabase
      .from("mail_accounts")
      .select("id, email_address, status")
      .eq("workspace_id", membership.workspace_id)
      .eq("provider", "outlook")
      .eq("status", "connected")
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!mailAccount) {
      return new Response(
        JSON.stringify({ ok: false, error: "Outlook not connected", needsReconnect: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch lead emails — scoped to the resolved workspace. We forward this
    // workspace to every per-lead outlook-sync, so a batch that (through staleness
    // or tampering) names a lead from ANOTHER workspace must not be synced against
    // this workspace's mailbox. Filtering here drops those out-of-workspace leads.
    const { data: leadsData, error: leadsErr } = await supabase
      .from("leads")
      .select("id, email")
      .in("id", leadIds)
      .eq("workspace_id", membership.workspace_id);

    if (leadsErr || !leadsData) {
      return new Response(JSON.stringify({ ok: false, error: "Failed to fetch leads" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const droppedCount = leadIds.length - leadsData.length;
    if (droppedCount > 0) {
      console.warn(`[outlook-bulk-sync] Dropped ${droppedCount} lead id(s) not in workspace ${membership.workspace_id}`);
    }

    console.log(`[outlook-bulk-sync] Starting bulk sync for ${leadsData.length} leads (account ${mailAccount.email_address})`);

    const results: PerLeadResult[] = [];
    let totalSynced = 0;
    const allErrors: string[] = [];
    let bulkNeedsReconnect = false;

    // Invoke outlook-sync per lead. We reuse the per-lead function so all
    // safeguards/pipeline logic stays in one place.
    for (const lead of leadsData) {
      if (!lead.email) {
        results.push({ leadId: lead.id, synced: 0, errors: ["Lead has no email"] });
        continue;
      }

      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/outlook-sync`, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            leadId: lead.id,
            leadEmail: lead.email,
            maxResults,
            // Forward the workspace this bulk run already resolved so outlook-sync
            // scopes to the same mailbox instead of re-resolving to the user's
            // first membership (workspace isolation for multi-workspace users).
            workspace_id: membership.workspace_id,
          }),
        });

        const data = await resp.json().catch(() => ({ ok: false, error: "Invalid response" }));

        if (data?.needsReconnect) {
          bulkNeedsReconnect = true;
          results.push({
            leadId: lead.id,
            synced: 0,
            errors: [data.error || "Outlook reconnect required"],
            needsReconnect: true,
          });
          // Stop early — token issue affects all subsequent leads
          break;
        }

        if (data?.ok) {
          const synced = Number(data.synced ?? 0);
          totalSynced += synced;
          results.push({
            leadId: lead.id,
            synced,
            errors: data.errors ?? [],
          });
        } else {
          const errMsg = data?.error || `Sync failed (${resp.status})`;
          results.push({ leadId: lead.id, synced: 0, errors: [errMsg] });
          allErrors.push(`${lead.id}: ${errMsg}`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        results.push({ leadId: lead.id, synced: 0, errors: [errMsg] });
        allErrors.push(`${lead.id}: ${errMsg}`);
      }
    }

    // Touch mail_accounts.last_sync_at for the bulk run
    await serviceSupabase
      .from("mail_accounts")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", mailAccount.id);

    console.log(`[outlook-bulk-sync] Completed. Total synced: ${totalSynced}, leads processed: ${results.length}`);

    return new Response(
      JSON.stringify({
        ok: true,
        totalSynced,
        leadsProcessed: results.length,
        results,
        errors: allErrors,
        needsReconnect: bulkNeedsReconnect,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[outlook-bulk-sync] Error:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    const needsReconnect =
      errorMessage.toLowerCase().includes("expired") ||
      errorMessage.toLowerCase().includes("revoked") ||
      errorMessage.toLowerCase().includes("reauthorize") ||
      errorMessage.toLowerCase().includes("permissions");

    return new Response(
      JSON.stringify({ ok: false, error: errorMessage, needsReconnect }),
      {
        status: needsReconnect ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
