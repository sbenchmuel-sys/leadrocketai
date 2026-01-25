import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";

export interface SyncResult {
  ok: boolean;
  synced?: number;
  total?: number;
  errors?: string[];
  error?: string;
  needsReconnect?: boolean;
}

// Helper to detect token/auth errors that require Gmail reconnection
function isReconnectError(error: string): boolean {
  const reconnectPhrases = [
    "invalid_grant",
    "revoked",
    "reconnect gmail",
    "refresh token",
    "token expired",
    "no refresh token",
  ];
  const lowerError = error.toLowerCase();
  return reconnectPhrases.some(phrase => lowerError.includes(phrase));
}

interface MilestoneItem {
  description: string;
  status: "completed" | "pending";
  date: string | null;
  evidence?: string;
  completedAt?: string;
}

export function useGmailSync() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncLead = async (leadId: string, leadEmail: string, maxResults = 20): Promise<SyncResult> => {
    try {
      setIsSyncing(true);
      setError(null);

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      if (!accessToken) {
        const errorMsg = "Not authenticated";
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      const response = await fetch(`${supabaseUrl}/functions/v1/gmail-sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ leadId, leadEmail, maxResults }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `Failed to sync Gmail: ${response.status}`;
        let needsReconnect = false;
        
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error) {
            errorMsg = errorJson.error;
            needsReconnect = isReconnectError(errorJson.error);
          }
        } catch {
          // Use default error message
        }
        
        setError(errorMsg);
        if (needsReconnect) {
          toast.error("Gmail needs reconnection", { 
            description: "Go to Settings to reconnect your Gmail account" 
          });
        } else {
          toast.error(errorMsg);
        }
        return { ok: false, error: errorMsg, needsReconnect };
      }

      const data = await response.json();

      if (!data.ok) {
        const errorMsg = data.error || "Gmail sync failed";
        const needsReconnect = isReconnectError(errorMsg);
        setError(errorMsg);
        if (needsReconnect) {
          toast.error("Gmail needs reconnection", { 
            description: "Go to Settings to reconnect your Gmail account" 
          });
        } else {
          toast.error(errorMsg);
        }
        return { ok: false, error: errorMsg, needsReconnect };
      }

      if (data.synced > 0) {
        toast.success(`Synced ${data.synced} email${data.synced > 1 ? 's' : ''} from Gmail`);
        
        // After syncing, check for milestone matches on outbound emails
        try {
          const completedCount = await matchEmailsToMilestones(leadId);
          if (completedCount > 0) {
            toast.success(`${completedCount} milestone${completedCount > 1 ? 's' : ''} auto-completed!`);
          }
        } catch (matchErr) {
          console.error("Milestone matching failed:", matchErr);
          // Don't fail the sync if matching fails
        }
      } else {
        toast.info("No new emails found");
      }

      return data as SyncResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setError(errorMsg);
      toast.error(errorMsg);
      return { ok: false, error: errorMsg };
    } finally {
      setIsSyncing(false);
    }
  };

  const sendEmail = async (
    to: string,
    subject: string,
    body: string,
    leadId?: string,
    draftId?: string
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> => {
    try {
      setIsSyncing(true);
      setError(null);

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      if (!accessToken) {
        const errorMsg = "Not authenticated";
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      const response = await fetch(`${supabaseUrl}/functions/v1/gmail-send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to, subject, body, leadId, draftId }),
      });

      if (!response.ok) {
        const errorMsg = `Failed to send email: ${response.status}`;
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      const data = await response.json();

      if (!data.ok) {
        const errorMsg = data.error || "Send email failed";
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      toast.success("Email sent successfully!");

      // After successful send, sync the lead to pull in the sent email
      if (leadId) {
        // Get lead email for sync
        const { data: leadData } = await supabase
          .from("leads")
          .select("email")
          .eq("id", leadId)
          .single();

        if (leadData?.email) {
          // Fire and forget - don't block on sync completion
          syncLead(leadId, leadData.email, 5).catch((err) => {
            console.error("[SendEmail] Post-send sync failed:", err);
          });
        }
      }

      return { ok: true, messageId: data.messageId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setError(errorMsg);
      toast.error(errorMsg);
      return { ok: false, error: errorMsg };
    } finally {
      setIsSyncing(false);
    }
  };

  // Match recent outbound emails against pending milestones
  const matchEmailsToMilestones = async (leadId: string): Promise<number> => {
    // Get lead's pending milestones
    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .select("milestones_json")
      .eq("id", leadId)
      .single();

    if (leadErr || !lead) return 0;

    const milestones: MilestoneItem[] = (lead.milestones_json as unknown as MilestoneItem[]) || [];
    const pendingMilestones = milestones.filter((m) => m.status === "pending");

    if (pendingMilestones.length === 0) return 0;

    // Get recent outbound interactions (last 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentEmails, error: emailsErr } = await supabase
      .from("interactions")
      .select("subject, body_text, direction")
      .eq("lead_id", leadId)
      .eq("direction", "outbound")
      .gte("occurred_at", oneDayAgo)
      .order("occurred_at", { ascending: false })
      .limit(5);

    if (emailsErr || !recentEmails || recentEmails.length === 0) return 0;

    // Combine recent outbound emails for analysis
    const emailsText = recentEmails
      .map((e) => `Subject: ${e.subject || "No subject"}\nBody: ${e.body_text?.slice(0, 500) || ""}`)
      .join("\n---\n");

    const pendingMilestonesText = pendingMilestones
      .map((m, i) => `[${i}] ${m.description}`)
      .join("\n");

    // Call AI to match emails to milestones
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;

    if (!accessToken) return 0;

    const aiResponse = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task: "match_email_to_milestones",
        payload: {
          email_subject: recentEmails[0]?.subject || "",
          email_body: emailsText,
          pending_milestones: pendingMilestonesText,
        },
      }),
    });

    if (!aiResponse.ok) return 0;

    const aiData = await aiResponse.json();
    if (!aiData.ok || !aiData.content) return 0;

    // Parse AI response
    let parsedResult: { completed_indices: number[]; reasoning: string };
    try {
      const content = aiData.content.trim();
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      const jsonStr = (jsonMatch?.[1] ?? content).trim();
      parsedResult = JSON.parse(jsonStr);
    } catch {
      console.error("Failed to parse AI milestone match result");
      return 0;
    }

    if (!parsedResult.completed_indices || parsedResult.completed_indices.length === 0) {
      return 0;
    }

    // Update milestones
    const now = new Date().toISOString();
    const updatedMilestones = milestones.map((m) => {
      if (m.status !== "pending") return m;

      // Find if this pending milestone's index was completed
      const pendingIndex = pendingMilestones.findIndex(
        (pm) => pm.description === m.description
      );
      if (parsedResult.completed_indices.includes(pendingIndex)) {
        return {
          ...m,
          status: "completed" as const,
          date: now.split("T")[0],
          completedAt: now,
        };
      }
      return m;
    });

    // Save updated milestones
    const { error: updateErr } = await supabase
      .from("leads")
      .update({
        milestones_json: updatedMilestones as unknown as Json,
        last_activity_at: now,
      })
      .eq("id", leadId);

    if (updateErr) {
      console.error("Failed to update milestones:", updateErr);
      return 0;
    }

    console.log(`[Gmail Sync] Auto-completed ${parsedResult.completed_indices.length} milestones`);
    return parsedResult.completed_indices.length;
  };

  return {
    syncLead,
    sendEmail,
    matchEmailsToMilestones,
    isSyncing,
    error,
  };
}
