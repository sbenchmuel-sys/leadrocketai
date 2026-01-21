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
  | "nurture_email_single"
  | "shorten_draft"
  | "post_meeting_followup_email"
  | "match_email_to_milestones"
  | "dedupe_milestones"
  | "reply_to_thread"
  | "analyze_outgoing_email";

export interface AITaskResponse {
  ok: boolean;
  content?: string;
  raw?: unknown;
  error?: string;
  error_id?: string;
}

export function useAITask() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runTask = async (
    task: AITaskType,
    payload: Record<string, unknown>,
    retries = 1
  ): Promise<AITaskResponse> => {
    setIsLoading(true);
    setError(null);

    let lastError: string | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Use supabase.functions.invoke for better reliability
        const { data, error: fnError } = await supabase.functions.invoke("ai_task", {
          body: { task, payload },
        });

        if (fnError) {
          console.error(`[useAITask] Function error (attempt ${attempt + 1}):`, fnError);
          
          // Check for specific HTTP errors
          if (fnError.message?.includes("429") || fnError.message?.includes("rate limit")) {
            lastError = "Rate limit exceeded. Please wait a moment and try again.";
            if (attempt < retries) {
              await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
              continue;
            }
          } else if (fnError.message?.includes("402") || fnError.message?.includes("payment")) {
            lastError = "AI credits depleted. Please add credits to continue.";
            break; // Don't retry payment errors
          } else if (fnError.message?.includes("500") || fnError.message?.includes("502") || fnError.message?.includes("503")) {
            lastError = "Server error. Retrying...";
            if (attempt < retries) {
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
              continue;
            }
          }
          
          lastError = fnError.message || "Failed to run AI task";
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          break;
        }

        // Check for error in response body
        if (!data?.ok) {
          const errorMsg = data?.error || "AI task failed";
          const errorId = data?.error_id;
          
          console.error(`[useAITask] Task returned error:`, errorMsg, errorId ? `(ID: ${errorId})` : "");
          
          if (errorMsg.includes("Rate limit")) {
            toast.error("Rate limit exceeded. Please wait a moment and try again.");
          } else if (errorMsg.includes("Payment required")) {
            toast.error("AI credits depleted. Please add credits to continue.");
          } else {
            toast.error(errorId ? `${errorMsg} (ID: ${errorId})` : errorMsg);
          }
          
          setError(errorMsg);
          return { ok: false, error: errorMsg, error_id: errorId };
        }

        // Success!
        setIsLoading(false);
        return data as AITaskResponse;

      } catch (err) {
        console.error(`[useAITask] Exception (attempt ${attempt + 1}):`, err);
        lastError = err instanceof Error ? err.message : "Unknown error";
        
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
      }
    }

    // All retries exhausted
    setIsLoading(false);
    setError(lastError);
    toast.error(lastError || "Failed to run AI task");
    return { ok: false, error: lastError || "Unknown error" };
  };

  return { runTask, isLoading, error };
}
