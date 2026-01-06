import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type AITaskType =
  | "intent_router"
  | "email_intro_fast"
  | "email_intro_nurture"
  | "followup_sequence_4"
  | "post_meeting_recap"
  | "answer_questions"
  | "extract_milestones_risks"
  | "extract_deal_factors"
  | "recommend_next_steps"
  | "linkedin_connect"
  | "linkedin_followup"
  | "pre_email_1_intro"
  | "pre_email_2_followup"
  | "pre_email_3_followup"
  | "pre_email_4_breakup"
  | "post_meeting_followup_personalized"
  | "nurture_sequence"
  | "shorten_draft";

export interface AITaskResponse {
  ok: boolean;
  content?: string;
  raw?: unknown;
  error?: string;
}

export function useAITask() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runTask = async (
    task: AITaskType,
    payload: Record<string, unknown>
  ): Promise<AITaskResponse> => {
    setIsLoading(true);
    setError(null);

    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      if (!accessToken) {
        const errorMsg = "Not authenticated";
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      const response = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ task, payload }),
      });

      if (!response.ok) {
        const errorMsg = `Failed to run AI task: ${response.status}`;
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      const data = await response.json();

      if (!data.ok) {
        const errorMsg = data.error || "AI task failed";
        setError(errorMsg);
        
        if (data.error?.includes("Rate limit")) {
          toast.error("Rate limit exceeded. Please wait a moment and try again.");
        } else if (data.error?.includes("Payment required")) {
          toast.error("AI credits depleted. Please add credits to continue.");
        } else {
          toast.error(errorMsg);
        }
        
        return { ok: false, error: errorMsg };
      }

      return data as AITaskResponse;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setError(errorMsg);
      toast.error(errorMsg);
      return { ok: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  };

  return { runTask, isLoading, error };
}
