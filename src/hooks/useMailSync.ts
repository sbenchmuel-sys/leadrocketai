// ============================================================
// useMailSync — Unified sync & send hook for Gmail + Outlook
//
// Abstracts provider differences behind a single interface.
// Resolves the active mail account from mail_accounts table,
// falls back to gmail_connections for legacy setups.
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";
import { getWorkspaceProfile } from "@/lib/workspaceProfileQueries";
import { getLeadActivityFeed } from "@/lib/leadActivity";

export type MailProvider = "gmail" | "outlook" | null;

export interface SyncResult {
  ok: boolean;
  synced?: number;
  total?: number;
  errors?: string[];
  error?: string;
  needsReconnect?: boolean;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  needsReconnect?: boolean;
}

export interface MailAccountInfo {
  id: string;
  provider: MailProvider;
  email_address: string;
  status: string;
  is_default: boolean;
  last_sync_at: string | null;
}

// Helper to detect token/auth errors requiring reconnection
function isReconnectError(error: string): boolean {
  const reconnectPhrases = [
    "invalid_grant",
    "revoked",
    "reconnect gmail",
    "refresh token",
    "token expired",
    "no refresh token",
    "expired",
    "unauthorized",
    "re-auth",
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

export function useMailSync() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeAccount, setActiveAccount] = useState<MailAccountInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Resolve the active mail account on mount
  const fetchActiveAccount = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setActiveAccount(null);
        return;
      }

      // Try mail_accounts first (preferred — supports both providers)
      const { data: defaultAccount } = await supabase
        .from("mail_accounts")
        .select("id, provider, email_address, status, is_default, last_sync_at")
        .eq("status", "connected")
        .eq("is_default", true)
        .maybeSingle();

      if (defaultAccount) {
        setActiveAccount(defaultAccount as MailAccountInfo);
        return;
      }

      // Fallback: any connected mail_account
      const { data: anyAccount } = await supabase
        .from("mail_accounts")
        .select("id, provider, email_address, status, is_default, last_sync_at")
        .eq("status", "connected")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (anyAccount) {
        setActiveAccount(anyAccount as MailAccountInfo);
        return;
      }

      // Legacy fallback: gmail_connections
      const { data: gmailConn } = await supabase
        .from("gmail_connections")
        .select("id, gmail_email, last_sync_at")
        .eq("user_id", user.id)
        .maybeSingle();

      if (gmailConn) {
        setActiveAccount({
          id: gmailConn.id,
          provider: "gmail",
          email_address: gmailConn.gmail_email,
          status: "connected",
          is_default: true,
          last_sync_at: gmailConn.last_sync_at,
        });
        return;
      }

      setActiveAccount(null);
    } catch {
      setActiveAccount(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActiveAccount();
  }, [fetchActiveAccount]);

  const provider: MailProvider = activeAccount?.provider ?? null;
  const isConnected = !!activeAccount;
  const providerLabel = provider === "outlook" ? "Outlook" : "Gmail";

  // ============================================================
  // syncLead — calls the appropriate sync edge function
  // ============================================================
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

      const syncFunction = provider === "outlook" ? "outlook-sync" : "gmail-sync";

      const bodyPayload: Record<string, unknown> = { leadId, leadEmail, maxResults };
      if (provider === "outlook" && activeAccount) {
        bodyPayload.mail_account_id = activeAccount.id;
      }

      const response = await fetch(`${supabaseUrl}/functions/v1/${syncFunction}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `Failed to sync ${providerLabel}: ${response.status}`;
        let needsReconnect = false;

        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error) {
            errorMsg = errorJson.error;
            needsReconnect = isReconnectError(errorJson.error) || !!errorJson.needsReconnect;
          }
        } catch {
          // Use default error message
        }

        setError(errorMsg);
        if (needsReconnect) {
          toast.error(`${providerLabel} needs reconnection`, {
            description: `Go to Settings to reconnect your ${providerLabel} account`,
          });
        } else {
          toast.error(errorMsg);
        }
        return { ok: false, error: errorMsg, needsReconnect };
      }

      const data = await response.json();

      if (!data.ok) {
        const errorMsg = data.error || `${providerLabel} sync failed`;
        const needsReconnect = isReconnectError(errorMsg) || !!data.needsReconnect;
        setError(errorMsg);
        if (needsReconnect) {
          toast.error(`${providerLabel} needs reconnection`, {
            description: `Go to Settings to reconnect your ${providerLabel} account`,
          });
        } else {
          toast.error(errorMsg);
        }
        return { ok: false, error: errorMsg, needsReconnect };
      }

      if (data.synced > 0) {
        toast.success(`Synced ${data.synced} email${data.synced > 1 ? "s" : ""} from ${providerLabel}`);

        // After syncing, check for milestone matches on outbound emails
        try {
          const completedCount = await matchEmailsToMilestones(leadId);
          if (completedCount > 0) {
            toast.success(`${completedCount} milestone${completedCount > 1 ? "s" : ""} auto-completed!`);
          }
        } catch (matchErr) {
          console.error("Milestone matching failed:", matchErr);
        }
      } else {
        toast.success("Inbox is up to date — no new emails to sync");
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

  // ============================================================
  // sendEmail — routes to the correct send edge function
  //
  // PR 2.4 — `outlookMessageId`:
  //   For per-email reply targeting on Outlook accounts, the target's
  //   Microsoft Graph long message-id (the AAMk... string) is what the
  //   `/messages/{id}/reply` endpoint expects. When provided, we forward
  //   it as the Outlook `threadId` so outlook-send takes the /reply path
  //   anchored on THIS specific message. Gmail accounts ignore it and
  //   still use `replyToMessageId` (RFC In-Reply-To/References).
  // ============================================================
  const sendEmail = async (
    to: string | string[],
    subject: string,
    body: string,
    leadId?: string,
    draftId?: string,
    threadId?: string,
    replyToMessageId?: string,
    cc?: string[],
    outlookMessageId?: string
  ): Promise<SendResult> => {
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

      // Normalize: callers may still pass a single string for legacy paths.
      // Edge functions accept either shape; we forward as-is plus optional cc[].
      const toPayload: string | string[] = to;
      const ccPayload: string[] | undefined = cc && cc.length > 0 ? cc : undefined;

      let sendFunction: string;
      let sendBody: Record<string, unknown>;

      if (provider === "outlook" && activeAccount) {
        sendFunction = "outlook-send";
        // Prefer the per-email Graph message-id when present so outlook-send
        // routes to /messages/{id}/reply. Falls back to threadId (which may
        // be a conversationId — outlook-send already handles that path).
        const outlookThread = outlookMessageId ?? threadId ?? null;
        sendBody = {
          mail_account_id: activeAccount.id,
          to: toPayload,
          ...(ccPayload ? { cc: ccPayload } : {}),
          subject,
          bodyHtml: body,
          threadId: outlookThread,
          leadId,
        };
      } else {
        sendFunction = "gmail-send";
        sendBody = {
          to: toPayload,
          ...(ccPayload ? { cc: ccPayload } : {}),
          subject,
          body,
          leadId,
          draftId,
          threadId,
          replyToMessageId,
        };
      }

      const response = await fetch(`${supabaseUrl}/functions/v1/${sendFunction}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sendBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `Failed to send email: ${response.status}`;
        let needsReconnect = false;

        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error) {
            errorMsg = errorJson.error;
            needsReconnect = isReconnectError(errorJson.error) || !!errorJson.needsReconnect;
          }
        } catch {
          // Use default error message
        }

        setError(errorMsg);
        if (needsReconnect) {
          toast.error(`${providerLabel} needs reconnection`, {
            description: `Go to Settings to reconnect your ${providerLabel} account`,
          });
        } else {
          toast.error(errorMsg);
        }
        return { ok: false, error: errorMsg, needsReconnect };
      }

      const data = await response.json();

      if (!data.ok) {
        const errorMsg = data.error || "Send email failed";
        const needsReconnect = isReconnectError(errorMsg) || !!data.needsReconnect;
        setError(errorMsg);
        if (needsReconnect) {
          toast.error(`${providerLabel} needs reconnection`, {
            description: `Go to Settings to reconnect your ${providerLabel} account`,
          });
        } else {
          toast.error(errorMsg);
        }
        return { ok: false, error: errorMsg, needsReconnect };
      }

      toast.success("Email sent successfully!");

      // Optimistic lead state update after send
      if (leadId) {
        const { data: leadData } = await supabase
          .from("leads")
          .select("email, stage, first_outbound_at, eligible_at, needs_action")
          .eq("id", leadId)
          .single();

        if (leadData) {
          const hasActiveAutomation =
            leadData.needs_action === true &&
            leadData.eligible_at &&
            new Date(leadData.eligible_at).getTime() > Date.now();

          const updates: Record<string, unknown> = {
            last_activity_at: new Date().toISOString(),
            last_outbound_at: new Date().toISOString(),
            ...(hasActiveAutomation ? {} : { needs_action: false }),
          };

          if (!leadData.first_outbound_at) {
            updates.first_outbound_at = new Date().toISOString();
          }

          if (leadData.stage === "new") {
            updates.stage = "contacted";
            updates.next_action_key = "wait_reply";
            updates.next_action_label = "Waiting for reply";
          }

          await supabase.from("leads").update(updates).eq("id", leadId);

          // Fire and forget post-send sync
          if (leadData.email) {
            syncLead(leadId, leadData.email, 5).catch((err) => {
              console.error("[useMailSync] Post-send sync failed:", err);
            });
          }
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

  // ============================================================
  // matchEmailsToMilestones — shared across providers
  // ============================================================
  const matchEmailsToMilestones = async (leadId: string): Promise<number> => {
    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .select("milestones_json")
      .eq("id", leadId)
      .single();

    if (leadErr || !lead) return 0;

    const milestones: MilestoneItem[] = (lead.milestones_json as unknown as MilestoneItem[]) || [];
    const pendingMilestones = milestones.filter((m) => m.status === "pending");
    if (pendingMilestones.length === 0) return 0;

    // Timeline-first: read recent outbound emails via the canonical lead activity
    // adapter (lead_timeline_items, with legacy interactions fallback baked in).
    // Preserves the original 24h window + 5-item cap + outbound-only semantics.
    const oneDayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
    let recentEmails: Array<{ subject: string | null; body_text: string | null }> = [];
    try {
      const activity = await getLeadActivityFeed(leadId, { channel: "email", limit: 30 });
      recentEmails = activity
        .filter((a) => a.direction === "outbound" && new Date(a.occurred_at).getTime() >= oneDayAgoMs)
        .slice(0, 5)
        .map((a) => ({ subject: a.subject, body_text: a.snippet_text }));
    } catch (err) {
      console.warn("[useMailSync] Activity feed read failed for milestone matching:", err);
    }

    if (recentEmails.length === 0) return 0;

    const emailsText = recentEmails
      .map((e) => `Subject: ${e.subject || "No subject"}\nBody: ${e.body_text?.slice(0, 500) || ""}`)
      .join("\n---\n");

    const pendingMilestonesText = pendingMilestones
      .map((m, i) => `[${i}] ${m.description}`)
      .join("\n");

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (!accessToken) return 0;

    let cadenceSettings = null;
    try {
      const workspaceProfile = await getWorkspaceProfile();
      if (workspaceProfile?.cadence_settings) {
        cadenceSettings = workspaceProfile.cadence_settings;
      }
    } catch (err) {
      console.warn("[useMailSync] Failed to load cadence settings:", err);
    }

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
          lead_id: leadId,
          cadence_settings: cadenceSettings,
        },
      }),
    });

    if (!aiResponse.ok) return 0;

    const aiData = await aiResponse.json();
    if (!aiData.ok || !aiData.content) return 0;

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

    const now = new Date().toISOString();
    const updatedMilestones = milestones.map((m) => {
      if (m.status !== "pending") return m;
      const pendingIndex = pendingMilestones.findIndex((pm) => pm.description === m.description);
      if (parsedResult.completed_indices.includes(pendingIndex)) {
        return { ...m, status: "completed" as const, date: now.split("T")[0], completedAt: now };
      }
      return m;
    });

    const { error: updateErr } = await supabase
      .from("leads")
      .update({ milestones_json: updatedMilestones as unknown as Json, last_activity_at: now })
      .eq("id", leadId);

    if (updateErr) {
      console.error("Failed to update milestones:", updateErr);
      return 0;
    }

    console.log(`[useMailSync] Auto-completed ${parsedResult.completed_indices.length} milestones`);
    return parsedResult.completed_indices.length;
  };

  return {
    // State
    isSyncing,
    isLoading,
    isConnected,
    error,
    provider,
    providerLabel,
    activeAccount,

    // Actions
    syncLead,
    sendEmail,
    matchEmailsToMilestones,
    refetch: fetchActiveAccount,
  };
}
