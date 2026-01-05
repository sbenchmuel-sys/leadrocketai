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
  | "linkedin_followup";

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
      const { data, error: fnError } = await supabase.functions.invoke("ai_task", {
        body: { task, payload },
      });

      if (fnError) {
        const errorMsg = fnError.message || "Failed to run AI task";
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

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
