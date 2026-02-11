import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { safeDecryptToken } from "../_shared/encryption.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Verify user from JWT
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversation_id");
  if (!conversationId) {
    return new Response(JSON.stringify({ error: "conversation_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verify user owns this conversation or is admin
  const { data: convo, error: convoErr } = await supabase
    .from("conversations")
    .select("id, workspace_id, owner_user_id")
    .eq("id", conversationId)
    .single();

  if (convoErr || !convo) {
    return new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Check workspace membership
  const { data: role } = await supabase.rpc("get_workspace_role", {
    _workspace_id: convo.workspace_id,
    _user_id: user.id,
  });

  if (!role) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Reps can only see own conversations
  if (role === "rep" && convo.owner_user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Fetch messages with metadata
  const { data: messages, error: msgErr } = await supabase
    .from("messages")
    .select("id, direction, body_ciphertext, media_type, created_at, expires_at, sender_identity_id, provider_message_id")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (msgErr) {
    return new Response(JSON.stringify({ error: msgErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Fetch latest analysis for this conversation (for expired message fallback)
  const { data: analysis } = await supabase
    .from("conversation_analysis")
    .select("summary_short, summary_text, sentiment, urgency, topics, extracted_features, recommended_reply_channel")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Decrypt available bodies
  const decryptedMessages = await Promise.all(
    (messages ?? []).map(async (msg) => {
      const expired = new Date(msg.expires_at) < new Date();
      let body_text: string | null = null;
      let is_expired = false;

      if (msg.body_ciphertext) {
        try {
          body_text = await safeDecryptToken(msg.body_ciphertext);
        } catch {
          body_text = null;
        }
      }

      if (!body_text && expired) {
        is_expired = true;
      }

      return {
        id: msg.id,
        direction: msg.direction,
        body_text,
        is_expired,
        media_type: msg.media_type,
        created_at: msg.created_at,
        sender_identity_id: msg.sender_identity_id,
      };
    })
  );

  return new Response(
    JSON.stringify({
      messages: decryptedMessages,
      analysis: analysis ?? null,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
