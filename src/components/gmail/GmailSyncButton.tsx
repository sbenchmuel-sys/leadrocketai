import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2, CheckCircle2, Clock, AlertTriangle, ExternalLink } from "lucide-react";
import { useMailSync } from "@/hooks/useMailSync";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { formatDistanceToNow } from "date-fns";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Alert,
  AlertDescription,
} from "@/components/ui/alert";
import { toast } from "sonner";

interface GmailSyncButtonProps {
  leadId: string;
  leadEmail: string;
  onSyncComplete?: () => void;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  showLastSync?: boolean;
  /** Scope the mailbox lookup to a workspace — pass the active workspace so a
   *  multi-workspace user syncs the right mailbox (matches the gate that
   *  decided to render this button). */
  workspaceId?: string | null;
}

export function GmailSyncButton({
  leadId,
  leadEmail,
  onSyncComplete,
  variant = "outline",
  size = "sm",
  showLastSync = true,
  workspaceId,
}: GmailSyncButtonProps) {
  const navigate = useNavigate();
  const { connectGmail } = useGmailConnection();
  const {
    syncLead,
    isSyncing,
    isConnected,
    isLoading,
    provider,
    providerLabel,
    activeAccount,
  } = useMailSync(workspaceId);

  const [justSynced, setJustSynced] = useState(false);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);

  useEffect(() => {
    if (justSynced) {
      const timer = setTimeout(() => setJustSynced(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [justSynced]);

  const handleSync = async () => {
    setNeedsReconnect(false);
    const result = await syncLead(leadId, leadEmail);
    if (result.ok) {
      setJustSynced(true);
      onSyncComplete?.();
    } else if (result.needsReconnect) {
      setNeedsReconnect(true);
    }
  };

  const handleReconnect = async () => {
    setIsReconnecting(true);
    try {
      if (provider === "outlook") {
        navigate("/settings");
        toast.info("Reconnect Outlook from Settings");
      } else {
        await connectGmail(window.location.pathname);
      }
    } catch {
      toast.error("Failed to start reconnection");
    } finally {
      setIsReconnecting(false);
    }
  };

  if (isLoading) {
    return (
      <Button variant={variant} size={size} disabled>
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  if (!isConnected) {
    return null;
  }

  const lastSyncAt = activeAccount?.last_sync_at;
  const lastSyncText = lastSyncAt
    ? `Last synced ${formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true })}`
    : "Never synced";

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-2">
        {needsReconnect && (
          <Alert variant="destructive" className="py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-2 text-xs">
              <span>{providerLabel} access expired</span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReconnect}
                disabled={isReconnecting}
                className="h-6 text-xs"
              >
                {isReconnecting ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    Reconnecting...
                  </>
                ) : (
                  <>
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Reconnect {providerLabel}
                  </>
                )}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant={variant}
                  size={size}
                  onClick={handleSync}
                  disabled={isSyncing}
                  className={justSynced ? "border-green-500/50 text-green-600" : ""}
                >
                  {isSyncing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Refreshing…
                    </>
                  ) : justSynced ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Updated
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Refresh
                    </>
                  )}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{lastSyncText}</p>
            </TooltipContent>
          </Tooltip>

          {showLastSync && lastSyncAt && !isSyncing && !justSynced && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true })}
            </span>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
