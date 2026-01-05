import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2 } from "lucide-react";
import { useGmailSync } from "@/hooks/useGmailSync";
import { useGmailConnection } from "@/hooks/useGmailConnection";

interface GmailSyncButtonProps {
  leadId: string;
  leadEmail: string;
  onSyncComplete?: () => void;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
}

export function GmailSyncButton({ 
  leadId, 
  leadEmail, 
  onSyncComplete,
  variant = "outline",
  size = "sm"
}: GmailSyncButtonProps) {
  const { isConnected, isLoading: isLoadingConnection } = useGmailConnection();
  const { syncLead, isSyncing } = useGmailSync();

  const handleSync = async () => {
    const result = await syncLead(leadId, leadEmail);
    if (result.ok && onSyncComplete) {
      onSyncComplete();
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

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleSync}
      disabled={isSyncing}
    >
      {isSyncing ? (
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
      ) : (
        <RefreshCw className="h-4 w-4 mr-2" />
      )}
      Sync Gmail
    </Button>
  );
}
