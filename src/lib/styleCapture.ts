import { supabase } from "@/integrations/supabase/client";

export type StyleFeedback = "sent" | "liked" | "disliked";
export type StyleChannel = "email" | "sms" | "whatsapp";
export type StyleMotion = "outbound_cold" | "reply_to_thread" | "nurture" | "follow_up";

/**
 * Captures a style example for AI learning.
 * Non-blocking — fires and forgets.
 */
export async function captureStyleExample({
  channel,
  motionType,
  bodyText,
  subject,
  feedback = "sent",
  feedbackComment,
  workspaceId,
}: {
  channel: StyleChannel;
  motionType: StyleMotion;
  bodyText: string;
  subject?: string;
  feedback?: StyleFeedback;
  feedbackComment?: string;
  workspaceId: string;
}) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Check if learning is paused
    if (feedback === "sent") {
      const { data: directive } = await supabase
        .from("user_style_directives")
        .select("learning_paused")
        .eq("user_id", user.id)
        .maybeSingle();
      if (directive?.learning_paused) return;
    }

    const { data: inserted } = await supabase.from("style_examples").insert({
      user_id: user.id,
      workspace_id: workspaceId,
      channel,
      motion_type: motionType,
      body_text: bodyText.slice(0, 5000),
      subject: subject?.slice(0, 500) || null,
      feedback,
      feedback_comment: feedbackComment?.slice(0, 500) || null,
    }).select("id").single();

    // Fire-and-forget: extract style features for this example
    if (inserted?.id) {
      supabase.functions.invoke("ai_task", {
        body: {
          task: "extract_style_features",
          payload: { example_id: inserted.id, body_text: bodyText.slice(0, 3000), channel, subject },
        },
      }).catch(() => {});
    }

    // Check if we should trigger synthesis (every 5 new examples)
    const { count } = await supabase
      .from("style_examples")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("channel", channel)
      .eq("motion_type", motionType);

    if (count && count >= 5 && count % 5 === 0) {
      // Trigger synthesis in background
      const session = (await supabase.auth.getSession()).data.session;
      if (session) {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        fetch(`${supabaseUrl}/functions/v1/synthesize-style-profile`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ channel, motion_type: motionType }),
        }).catch(() => {}); // fire and forget
      }
    }
  } catch (err) {
    console.error("[captureStyleExample] Error:", err);
  }
}
