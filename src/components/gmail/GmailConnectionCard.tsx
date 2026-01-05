import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { toast } from "@/components/ui/use-toast";
import { Loader2, Mail, AlertCircle, ExternalLink, MailCheck, RefreshCw, Unplug } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

interface GmailConnectionCardProps {
  onConnectionChange?: () => void;
}

export function GmailConnectionCard({ onConnectionChange }: GmailConnectionCardProps) {
  const { connection, isConnected, isLoading, error, authUrl, prepareOAuth, clearAuthUrl, disconnect } = useGmailConnection();

  const handleConnect = async () => {
    try {
      toast({ title: "Preparing Gmail authorization...", description: "Click the link to sign in with Google" });
      await prepareOAuth();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to prepare OAuth";
      toast({ title: "Connection failed", description: message, variant: "destructive" });
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
      onConnectionChange?.();
    } catch {
      // Error is already handled in the hook
    }
  };

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
            <CardTitle className="text-lg">Gmail Integration</CardTitle>
          </div>
          {isConnected && (
            <Badge variant="secondary" className="bg-green-500/10 text-green-600">
              <MailCheck className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
        </div>
        <CardDescription>
          {isConnected
            ? "Sync emails automatically and send messages directly from the app"
            : "Connect your Gmail to sync emails and send messages"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>{error}</span>
              <Button variant="ghost" size="sm" onClick={handleConnect} className="ml-2">
                <RefreshCw className="h-3 w-3 mr-1" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {isConnected && connection ? (
          <div className="space-y-4">
            <div className="text-sm space-y-1">
              <p className="text-muted-foreground">Connected account:</p>
              <p className="font-medium">{connection.gmail_email}</p>
            </div>
            {connection.last_sync_at && (
              <div className="text-sm">
                <span className="text-muted-foreground">Last synced: </span>
                <span>{format(new Date(connection.last_sync_at), "PPp")}</span>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={handleDisconnect} className="text-destructive">
              <Unplug className="h-4 w-4 mr-2" />
              Disconnect Gmail
            </Button>
          </div>
        ) : authUrl ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Click the link below to authorize Gmail access in a new window:
            </p>
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-primary hover:underline font-medium"
            >
              <ExternalLink className="h-4 w-4" />
              Open Google Authorization
            </a>
            <div>
              <Button variant="ghost" size="sm" onClick={clearAuthUrl}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={handleConnect}>
            <Mail className="h-4 w-4 mr-2" />
            Connect Gmail
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
