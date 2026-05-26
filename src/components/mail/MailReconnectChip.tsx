// ============================================================
// MailReconnectChip — inline "Sync paused — reconnect" pill
//
// Used on Lead Detail header and Inbox header. Returns null when
// no mail account in the active workspace needs reconnection, so
// callers can render it unconditionally.
// ============================================================

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useReconnectMail, type MailProviderName } from "@/hooks/useReconnectMail";

interface DisconnectedAccount {
  id: string;
  provider: string;
  email_address: string;
}

interface MailReconnectChipProps {
  /** Optional compact form (icon + button only). Defaults to false (full text). */
  compact?: boolean;
  className?: string;
}

export function MailReconnectChip({ compact = false, className }: MailReconnectChipProps) {
  const { workspaceId } = useWorkspace();
  const { reconnect, isConnecting } = useReconnectMail();
  const [account, setAccount] = useState<DisconnectedAccount | null>(null);

  const fetchAccount = useCallback(async () => {
    if (!workspaceId) {
      setAccount(null);
      return;
    }
    const { data } = await supabase
      .from("mail_accounts")
      .select("id, provider, email_address")
      .eq("workspace_id", workspaceId)
      .or("needs_reconnect.eq.true,status.eq.error")
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();
    setAccount((data as DisconnectedAccount) ?? null);
  }, [workspaceId]);

  useEffect(() => {
    fetchAccount();
  }, [fetchAccount]);

  useEffect(() => {
    if (!workspaceId) return;
    const channel = supabase
      .channel(`mail-chip-${workspaceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "mail_accounts",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        () => fetchAccount()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId, fetchAccount]);

  if (!account) return null;

  const providerLabel = account.provider === "outlook" ? "Outlook" : "Gmail";

  const handleClick = async () => {
    try {
      await reconnect(account.provider as MailProviderName, {
        workspaceId: workspaceId ?? undefined,
        onComplete: fetchAccount,
      });
    } catch {
      // toast surfaced inside the hook
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={isConnecting}
      className={`h-8 text-xs border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-800/50 ${className ?? ""}`}
    >
      {isConnecting ? (
        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
      )}
      {compact ? `Reconnect ${providerLabel}` : `Sync paused — reconnect ${providerLabel}`}
    </Button>
  );
}
