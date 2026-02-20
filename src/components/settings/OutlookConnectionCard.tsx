import React, { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Loader2, Mail, AlertCircle, CheckCircle2, Unplug, RefreshCw, AlertTriangle, Info } from "lucide-react";
import { format, formatDistanceToNow, isPast, addHours } from "date-fns";

interface OutlookAccount {
  email_address: string;
  status: string;
  is_default: boolean;
  token_expiry: string | null;
  subscription_expiry: string | null;
  subscription_status: string;
  last_sync_at: string | null;
  error_reason: string | null;
}

interface OutlookHealthData {
  accounts: OutlookAccount[];
}

/** Small helper that wraps Button in an optional tooltip (used for the disabled-credentials state). */
const ConnectButton = React.forwardRef<
  HTMLButtonElement,
  {
    onClick: () => void;
    disabled?: boolean;
    tooltip?: string;
    loading?: boolean;
    variant?: "default" | "outline" | "ghost";
    size?: "default" | "sm" | "lg";
    children: React.ReactNode;
  }
>(({ onClick, disabled, tooltip, loading, variant, size, children }, ref) => {
  const btn = (
    <Button ref={ref} onClick={onClick} disabled={disabled} variant={variant} size={size}>
      {loading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <Mail className="h-4 w-4 mr-2" />
      )}
      {children}
    </Button>
  );

  if (tooltip && disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* span needed because disabled button doesn't fire events */}
            <span className="inline-flex">{btn}</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs max-w-[200px]">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return btn;
});
ConnectButton.displayName = "ConnectButton";

export function OutlookConnectionCard() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [healthData, setHealthData] = useState<OutlookHealthData | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // null = unknown, true = configured, false = missing
  const [credentialsConfigured, setCredentialsConfigured] = useState<boolean | null>(null);

  const fetchWorkspaceId = useCallback(async () => {
    if (!user) return null;
    const { data } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
    return data?.workspace_id ?? null;
  }, [user]);

  const fetchHealth = useCallback(async (wsId: string) => {
    try {
      setIsLoading(true);
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) return;

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const resp = await fetch(
        `${supabaseUrl}/functions/v1/outlook-health?workspace_id=${wsId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (resp.ok) {
        const json = await resp.json();
        if (json.ok) setHealthData(json);
      }
    } catch (err) {
      console.error("[Outlook] Health check failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const wsId = await fetchWorkspaceId();
      setWorkspaceId(wsId);
      if (wsId) {
        await fetchHealth(wsId);
      } else {
        setIsLoading(false);
      }
      // Assume credentials configured until proven otherwise at connect time
      setCredentialsConfigured(true);
    })();
  }, [fetchWorkspaceId, fetchHealth]);

  const handleConnect = async () => {
    if (credentialsConfigured === false) return;
    try {
      setIsConnecting(true);

      // Always re-fetch workspace_id to avoid stale state race conditions
      let wsId = workspaceId ?? await fetchWorkspaceId();
      if (!wsId) {
        toast.error("No workspace found", { description: "Please refresh the page and try again." });
        setIsConnecting(false);
        return;
      }
      setWorkspaceId(wsId);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("Not authenticated");

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const resp = await fetch(`${supabaseUrl}/functions/v1/outlook-auth`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: wsId,
          redirectUrl: window.location.href,
        }),
      });

      const data = await resp.json().catch(() => ({ ok: false, error: "Invalid response" }));

      if (data.not_configured) {
        setCredentialsConfigured(false);
        throw new Error("Outlook integration not fully configured. Please contact your administrator.");
      }
      if (!resp.ok || !data.ok) {
        throw new Error(data.error || `Request failed (${resp.status})`);
      }
      if (!data.authUrl) {
        throw new Error("Failed to get auth URL");
      }

      // Open in a popup to avoid breaking the preview iframe
      const popup = window.open(data.authUrl, "outlook_oauth", "width=520,height=650,left=200,top=100");
      if (!popup) {
        // Fallback: navigate current tab if popup blocked
        window.location.href = data.authUrl;
        return;
      }

      // Poll until the popup closes, then refresh health
      const poll = setInterval(async () => {
        if (popup.closed) {
          clearInterval(poll);
          setIsConnecting(false);
          const wsId = await fetchWorkspaceId();
          if (wsId) await fetchHealth(wsId);
        }
      }, 800);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect Outlook";
      toast.error("Connection failed", { description: message });
      setIsConnecting(false);
    }
  };

  const connectDisabled = isConnecting || credentialsConfigured === false;
  const connectTooltip =
    credentialsConfigured === false
      ? "Outlook integration not fully configured yet"
      : undefined;

  const handleDisconnect = async (email: string) => {
    if (!workspaceId) {
      toast.error("Failed to disconnect", { description: "Workspace not found. Please refresh." });
      return;
    }
    try {
      const { error } = await supabase
        .from("mail_accounts")
        .update({ status: "disconnected" })
        .eq("email_address", email)
        .eq("provider", "outlook")
        .eq("workspace_id", workspaceId);

      if (error) throw error;
      toast.success("Outlook disconnected");
      await fetchHealth(workspaceId);
    } catch (err) {
      console.error("[Outlook] Disconnect error:", err);
      toast.error("Failed to disconnect", { description: "Please try again." });
    }
  };

  const getStatusBadge = (account: OutlookAccount) => {
    const isExpiringSoon =
      account.subscription_expiry &&
      !isPast(new Date(account.subscription_expiry)) &&
      isPast(addHours(new Date(), -24)) &&
      new Date(account.subscription_expiry) < addHours(new Date(), 24);

    if (account.status === "connected") {
      return (
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-[11px] border-0 text-primary/80 bg-primary/10">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Connected
          </Badge>
          {isExpiringSoon && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
                    <AlertTriangle className="h-3 w-3 mr-0.5" />
                    Renewing soon
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Subscription expires {formatDistanceToNow(new Date(account.subscription_expiry!), { addSuffix: true })}. Will auto-renew.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      );
    }

    if (account.status === "expired") {
      return (
        <Badge variant="destructive" className="text-xs">
          <AlertCircle className="h-3 w-3 mr-1" />
          Token Expired
        </Badge>
      );
    }

    if (account.status === "error") {
      return (
        <Badge variant="outline" className="border-destructive/50 text-destructive text-xs">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Error
        </Badge>
      );
    }

    return (
      <Badge variant="secondary" className="text-xs">
        {account.status}
      </Badge>
    );
  };

  const connectedAccounts = healthData?.accounts.filter(
    (a) => a.status !== "disconnected"
  ) ?? [];

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            <CardTitle className="text-lg">Outlook</CardTitle>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 border-border text-muted-foreground cursor-help"
                  >
                    <Info className="h-2.5 w-2.5 mr-0.5" />
                    Beta
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[220px] text-xs">
                  Outlook integration is in beta. Multi-mailbox supported. Shared mailboxes not yet supported.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
        <CardDescription>
          {connectedAccounts.length > 0
            ? "Your Outlook account is connected for email sending and reply detection"
            : "Connect your Microsoft Outlook account via OAuth"}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Connected accounts */}
        {connectedAccounts.map((account) => (
          <div key={account.email_address} className="space-y-3">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  {getStatusBadge(account)}
                  {account.is_default && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Default</Badge>
                  )}
                </div>
                <p className="text-sm font-medium">{account.email_address}</p>
                {account.last_sync_at && (
                  <p className="text-xs text-muted-foreground">
                    Last synced {formatDistanceToNow(new Date(account.last_sync_at), { addSuffix: true })}
                  </p>
                )}
              </div>
            </div>

            {/* Warning for non-connected status */}
            {account.status !== "connected" && (
              <Alert variant="destructive" className="py-2">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  {account.status === "expired"
                    ? "Outlook connection requires re-authentication. Please reconnect your account."
                    : account.error_reason
                    ? `Connection error: ${account.error_reason}`
                    : "Outlook connection requires re-authentication."}
                </AlertDescription>
              </Alert>
            )}

            <div className="flex gap-2">
              {account.status !== "connected" && (
                <Button size="sm" onClick={handleConnect} disabled={isConnecting}>
                  {isConnecting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Reconnect
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDisconnect(account.email_address)}
                className="text-destructive"
              >
                <Unplug className="h-4 w-4 mr-2" />
                Disconnect
              </Button>
            </div>
          </div>
        ))}

        {/* No accounts — show connect button */}
        {connectedAccounts.length === 0 && (
          <ConnectButton
            onClick={handleConnect}
            disabled={connectDisabled}
            tooltip={connectTooltip}
            loading={isConnecting}
          >
            Connect Outlook
          </ConnectButton>
        )}

      </CardContent>
    </Card>
  );
}
