import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2, CheckCircle2, Clock } from "lucide-react";
import { useGmailSync } from "@/hooks/useGmailSync";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { formatDistanceToNow } from "date-fns";
import { useState, useEffect } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface GmailSyncButtonProps {
  leadId: string;
  leadEmail: string;
  onSyncComplete?: () => void;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  showLastSync?: boolean;
}

export function GmailSyncButton({ 
  leadId, 
  leadEmail, 
  onSyncComplete,
  variant = "outline",
  size = "sm",
  showLastSync = true
}: GmailSyncButtonProps) {
  const { connection, isConnected, isLoading: isLoadingConnection, refetch } = useGmailConnection();
  const { syncLead, isSyncing } = useGmailSync();
  const [justSynced, setJustSynced] = useState(false);

  // Reset "just synced" indicator after 3 seconds
  useEffect(() => {
    if (justSynced) {
      const timer = setTimeout(() => setJustSynced(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [justSynced]);

  const handleSync = async () => {
    const result = await syncLead(leadId, leadEmail);
    if (result.ok) {
      setJustSynced(true);
      refetch(); // Refresh connection to get updated last_sync_at
      onSyncComplete?.();
    }
  };

  if (isLoadingConnection) {
    return (
      <Button variant={variant} size={size} disabled>
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  if (!isConnected) {
    return null;
  }

  const lastSyncAt = connection?.last_sync_at;
  const lastSyncText = lastSyncAt 
    ? `Last synced ${formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true })}`
    : "Never synced";

  return (
    <TooltipProvider>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
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
                  Syncing...
                </>
              ) : justSynced ? (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Synced!
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Sync Gmail
                </>
              )}
            </Button>
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
    </TooltipProvider>
  );
}
