import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Loader2, MessageSquare, AlertCircle, CheckCircle2, Unplug } from "lucide-react";

export function WhatsAppConnectionCard() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connection, setConnection] = useState<{
    id: string;
    provider_account_id: string | null;
    is_active: boolean;
    last_sync_at: string | null;
  } | null>(null);

  // Form fields
  const [accessToken, setAccessToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");

  const fetchConnection = useCallback(async () => {
    if (!user) return;
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("integrations")
        .select("id, provider_account_id, is_active, last_sync_at")
        .eq("user_id", user.id)
        .eq("type", "whatsapp")
        .eq("is_active", true)
        .maybeSingle();

      if (error) throw error;
      setConnection(data);
    } catch (err) {
      console.error("[WhatsApp] Failed to fetch connection:", err);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchConnection();
  }, [fetchConnection]);

  const handleConnect = async () => {
    if (!accessToken.trim() || !phoneNumberId.trim()) {
      toast.error("Access Token and Phone Number ID are required");
      return;
    }

    try {
      setIsConnecting(true);

      // Get workspace_id from workspace_members
      const { data: membership, error: memErr } = await supabase
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", user!.id)
        .limit(1)
        .single();

      if (memErr || !membership) {
        throw new Error("Could not find your workspace. Please contact support.");
      }

      const { data, error } = await supabase.functions.invoke("whatsapp-connect", {
        body: {
          workspace_id: membership.workspace_id,
          access_token: accessToken.trim(),
          phone_number_id: phoneNumberId.trim(),
          waba_id: wabaId.trim() || undefined,
        },
      });

      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error(data?.error || "Connection failed");

      toast.success("WhatsApp connected!", { description: "Your WhatsApp Business account has been linked." });
      setAccessToken("");
      setPhoneNumberId("");
      setWabaId("");
      await fetchConnection();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect WhatsApp";
      toast.error("Connection failed", { description: message });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!connection) return;
    try {
      const { error } = await supabase
        .from("integrations")
        .update({ is_active: false })
        .eq("id", connection.id);

      if (error) throw error;
      setConnection(null);
      toast.success("WhatsApp disconnected");
    } catch (err) {
      toast.error("Failed to disconnect");
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
            <MessageSquare className="h-5 w-5" />
            <CardTitle className="text-lg">WhatsApp Business</CardTitle>
          </div>
          {connection && (
            <Badge variant="secondary" className="bg-green-500/10 text-green-600">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
        </div>
        <CardDescription>
          {connection
            ? "Your WhatsApp Business account is connected for messaging"
            : "Connect your WhatsApp Business account via the Cloud API"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connection ? (
          <div className="space-y-4">
            <div className="text-sm space-y-1">
              <p className="text-muted-foreground">Phone Number ID:</p>
              <p className="font-medium font-mono">{connection.provider_account_id}</p>
            </div>
            <Button variant="outline" size="sm" onClick={handleDisconnect} className="text-destructive">
              <Unplug className="h-4 w-4 mr-2" />
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Get these from the{" "}
                <a
                  href="https://developers.facebook.com/apps"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium"
                >
                  Meta Developer Portal
                </a>{" "}
                → Your App → WhatsApp → API Setup.
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <Label htmlFor="wa-token">Access Token *</Label>
              <Input
                id="wa-token"
                type="password"
                placeholder="Temporary or permanent access token"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="wa-phone-id">Phone Number ID *</Label>
              <Input
                id="wa-phone-id"
                placeholder="e.g. 123456789012345"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="wa-waba-id">WABA ID (optional)</Label>
              <Input
                id="wa-waba-id"
                placeholder="WhatsApp Business Account ID"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
              />
            </div>

            <Button onClick={handleConnect} disabled={isConnecting}>
              {isConnecting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <MessageSquare className="h-4 w-4 mr-2" />
              )}
              Connect WhatsApp
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
