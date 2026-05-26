// ============================================================
// MailConnectionBanner — global "your email is disconnected" prompt
//
// Mounted in DashboardLayout. Reads mail_accounts for the active
// workspace and surfaces any row with needs_reconnect=true or
// status='error' as a top-of-app banner with a one-click reconnect.
// Dismissable per browser session.
// ============================================================

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useReconnectMail, type MailProviderName } from "@/hooks/useReconnectMail";

interface DisconnectedAccount {
  id: string;
  provider: string;
  email_address: string;
  status: string;
  needs_reconnect: boolean;
  error_reason: string | null;
}

const DISMISS_KEY_PREFIX = "mail-banner-dismissed:";

export function MailConnectionBanner() {
  const { workspaceId } = useWorkspace();
  const { reconnect, isConnecting } = useReconnectMail();
  const [accounts, setAccounts] = useState<DisconnectedAccount[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Load per-session dismissals from sessionStorage
  useEffect(() => {
    const dismissedIds = new Set<string>();
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(DISMISS_KEY_PREFIX)) {
        dismissedIds.add(key.slice(DISMISS_KEY_PREFIX.length));
      }
    }
    setDismissed(dismissedIds);
  }, []);

  const fetchAccounts = useCallback(async () => {
    if (!workspaceId) {
      setAccounts([]);
      return;
    }
    const { data } = await supabase
      .from("mail_accounts")
      .select("id, provider, email_address, status, needs_reconnect, error_reason")
      .eq("workspace_id", workspaceId)
      .or("needs_reconnect.eq.true,status.eq.error");
    setAccounts((data ?? []) as DisconnectedAccount[]);
  }, [workspaceId]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Realtime subscription to mail_accounts so the banner reacts the
  // instant a token-refresh edge function flips needs_reconnect — no
  // page reload required.
  useEffect(() => {
    if (!workspaceId) return;
    const channel = supabase
      .channel(`mail-accounts-${workspaceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "mail_accounts",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        () => fetchAccounts()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId, fetchAccounts]);

  const handleDismiss = (id: string) => {
    sessionStorage.setItem(DISMISS_KEY_PREFIX + id, "1");
    setDismissed(prev => new Set(prev).add(id));
  };

  const handleReconnect = async (account: DisconnectedAccount) => {
    try {
      const provider = account.provider as MailProviderName;
      await reconnect(provider, {
        workspaceId: workspaceId ?? undefined,
        onComplete: fetchAccounts,
      });
    } catch {
      // toast already shown inside the hook
    }
  };

  const visible = accounts.filter(a => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-2 mb-4">
      {visible.map(account => {
        const providerLabel = account.provider === "outlook" ? "Outlook" : "Gmail";
        return (
          <div
            key={account.id}
            className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm"
            role="alert"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            <div className="flex-1 min-w-0">
              <span className="font-medium">{providerLabel} disconnected</span>
              <span className="text-muted-foreground"> — </span>
              <span className="truncate">{account.email_address}</span>
              {account.error_reason && (
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {account.error_reason}
                </div>
              )}
            </div>
            <Button
              size="sm"
              variant="default"
              onClick={() => handleReconnect(account)}
              disabled={isConnecting}
            >
              {isConnecting ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              Reconnect
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
              onClick={() => handleDismiss(account.id)}
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
