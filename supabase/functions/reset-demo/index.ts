import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authenticate
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify user with anon client
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // Use service role for deletions (bypasses RLS)
    const admin = createClient(supabaseUrl, serviceKey);

    // 1. Get user's workspace IDs
    const { data: memberships } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId);

    const workspaceIds = (memberships ?? []).map((m: any) => m.workspace_id);

    // 2. Delete workspace-scoped tables (children first)
    if (workspaceIds.length > 0) {
      await admin.from("conversation_analysis").delete().in("workspace_id", workspaceIds);
      await admin.from("messages").delete().in("workspace_id", workspaceIds);
      await admin.from("conversations").delete().in("workspace_id", workspaceIds);
      await admin.from("contact_identities").delete().in("workspace_id", workspaceIds);
      await admin.from("contacts").delete().in("workspace_id", workspaceIds);
      await admin.from("integrations").delete().in("workspace_id", workspaceIds);
      await admin.from("manager_views").delete().in("workspace_id", workspaceIds);
    }

    // 3. Delete user-scoped tables (children first)
    // First get lead IDs for dependent tables
    const { data: leads } = await admin
      .from("leads")
      .select("id")
      .eq("owner_user_id", userId);

    const leadIds = (leads ?? []).map((l: any) => l.id);

    if (leadIds.length > 0) {
      await admin.from("drafts").delete().in("lead_id", leadIds);
      await admin.from("interactions").delete().in("lead_id", leadIds);
      await admin.from("meeting_packs").delete().in("lead_id", leadIds);
      await admin.from("meeting_summaries").delete().in("lead_id", leadIds);
    }

    await admin.from("leads").delete().eq("owner_user_id", userId);
    await admin.from("kb_chunks").delete().eq("owner_user_id", userId);
    await admin.from("onboarding_config").delete().eq("user_id", userId);
    await admin.from("rep_signatures").delete().eq("user_id", userId);
    await admin.from("rep_profiles").delete().eq("user_id", userId);
    await admin.from("workspace_profiles").delete().eq("user_id", userId);
    await admin.from("gmail_connections").delete().eq("user_id", userId);
    await admin.from("oauth_states").delete().eq("user_id", userId);
    await admin.from("unmatched_meeting_summaries").delete().eq("user_id", userId);
    await admin.from("meeting_summaries").delete().eq("user_id", userId);
    await admin.from("org_settings").delete().eq("user_id", userId);

    // 4. Delete workspace membership and workspaces
    await admin.from("workspace_members").delete().eq("user_id", userId);
    if (workspaceIds.length > 0) {
      await admin.from("workspaces").delete().in("id", workspaceIds);
    }

    // 5. Reset profile
    await admin
      .from("profiles")
      .update({ onboarding_done: false, onboarding_step: 0 })
      .eq("user_id", userId);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("reset-demo error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
