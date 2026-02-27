import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { toast } from "sonner";
import {
  Loader2,
  MessageSquare,
  AlertCircle,
  CheckCircle2,
  Unplug,
  ChevronDown,
  Settings2,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────
interface ConnectionInfo {
  id: string;
  provider: string;
  provider_account_id: string | null;
  is_active: boolean;
  last_sync_at: string | null;
}

interface HealthResult {
  connected: boolean;
  healthy: boolean;
  status: string;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────
function formatPhone(digits: string | null): string {
  if (!digits) return "—";
  return `+${digits}`;
}

const E164_RE = /^\+[1-9]\d{6,14}$/;

// ================================================================
// Main Component
// ================================================================
export function WhatsAppConnectionCard() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);

  // ── Fetch existing connection ──────────────────────
  const fetchConnection = useCallback(async () => {
    if (!user) return;
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("integrations")
        .select("id, provider, provider_account_id, is_active, last_sync_at")
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

  // ── Disconnect ────────────────────────────────────
  const handleDisconnect = async () => {
    if (!connection) return;
    try {
      const { error } = await supabase
        .from("integrations")
        .update({ is_active: false })
        .eq("id", connection.id);
      if (error) throw error;
      setConnection(null);
      setHealth(null);
      toast.success("WhatsApp disconnected");
    } catch {
      toast.error("Failed to disconnect");
    }
  };

  // ── Loading state ─────────────────────────────────
  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // ── Connected state ───────────────────────────────
  if (connection) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              <CardTitle className="text-lg">WhatsApp Business</CardTitle>
            </div>
            <Badge variant="secondary" className="bg-green-500/10 text-green-600">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          </div>
          <CardDescription>Your WhatsApp Business account is connected for messaging</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm space-y-1">
            <p className="text-muted-foreground">Phone:</p>
            <p className="font-medium font-mono">{formatPhone(connection.provider_account_id)}</p>
          </div>

          {health && (
            <div className="text-sm space-y-1">
              <p className="text-muted-foreground">Status:</p>
              <p className={`font-medium ${health.healthy ? "text-green-600" : "text-yellow-600"}`}>
                {health.healthy ? "Active" : health.error || "Unreachable"}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <Button variant="outline" size="sm" onClick={handleDisconnect} className="text-destructive">
              <Unplug className="h-4 w-4 mr-2" />
              Disconnect
            </Button>
            <span className="text-[11px] text-muted-foreground">Powered by DrivePilot</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Not connected – show forms ────────────────────
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          <CardTitle className="text-lg">WhatsApp Business</CardTitle>
        </div>
        <CardDescription>Connect your WhatsApp Business account</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Default form (Twilio, white-labeled) */}
        <TwilioConnectForm onConnected={fetchConnection} />

        {/* Legacy Meta form behind advanced toggle */}
        <Collapsible open={showLegacy} onOpenChange={setShowLegacy}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground gap-1 px-0">
              <Settings2 className="h-3 w-3" />
              Advanced / Legacy Provider
              <ChevronDown className={`h-3 w-3 transition-transform ${showLegacy ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-4">
            <MetaConnectForm onConnected={fetchConnection} />
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

// ================================================================
// Twilio Connect Form (white-labeled, default)
// ================================================================
function TwilioConnectForm({ onConnected }: { onConnected: () => Promise<void> }) {
  const { user } = useAuth();
  const { workspaceId } = useWorkspace();
  const [isConnecting, setIsConnecting] = useState(false);
  const [phone, setPhone] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [messagingServiceSid, setMessagingServiceSid] = useState("");
  const [senderSid, setSenderSid] = useState("");

  const phoneValid = E164_RE.test(phone.trim());

  const handleConnect = async () => {
    if (!phoneValid) {
      toast.error("Enter a valid phone number in E.164 format (e.g. +9725XXXXXXXX)");
      return;
    }

    try {
      setIsConnecting(true);

      if (!workspaceId) {
        toast.error("No workspace available. Please refresh the page.");
        return;
      }

      const { data, error } = await supabase.functions.invoke("whatsapp-connect-twilio", {
        body: {
          workspace_id: workspaceId,
          twilio_phone_number: phone.trim(),
          messaging_service_sid: messagingServiceSid.trim() || undefined,
          twilio_sender_sid: senderSid.trim() || undefined,
        },
      });

      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error(data?.error || "Connection failed");

      // Health check
      try {
        const { data: healthData } = await supabase.functions.invoke("whatsapp-health", {
          body: { workspace_id: workspaceId },
        });
        if (healthData && !healthData.healthy) {
          toast.warning("Connection saved, but WhatsApp provider not reachable.", { duration: 5000 });
        }
      } catch {
        // non-blocking
      }

      toast.success("WhatsApp connected!", { description: "Your WhatsApp Business account has been linked." });
      setPhone("");
      setMessagingServiceSid("");
      setSenderSid("");
      await onConnected();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect WhatsApp";
      if (message.toLowerCase().includes("twilio") && message.toLowerCase().includes("not configured")) {
        toast.error("WhatsApp infrastructure not configured. Contact administrator.");
      } else {
        toast.error("Connection failed", { description: message });
      }
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="wa-phone">WhatsApp Business Phone Number *</Label>
        <Input
          id="wa-phone"
          placeholder="+9725XXXXXXXX"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        {phone && !phoneValid && (
          <p className="text-xs text-destructive">Must be E.164 format (e.g. +9725XXXXXXXX)</p>
        )}
      </div>

      <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground gap-1 px-0">
            <ChevronDown className={`h-3 w-3 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
            Advanced Options
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 space-y-3">
          <div className="space-y-2">
            <Label htmlFor="wa-msid">Messaging Service SID</Label>
            <Input
              id="wa-msid"
              placeholder="MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              value={messagingServiceSid}
              onChange={(e) => setMessagingServiceSid(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wa-sender">Sender SID</Label>
            <Input
              id="wa-sender"
              placeholder="Optional — uses account default if empty"
              value={senderSid}
              onChange={(e) => setSenderSid(e.target.value)}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Button onClick={handleConnect} disabled={isConnecting || !phoneValid}>
        {isConnecting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <MessageSquare className="h-4 w-4 mr-2" />
        )}
        Connect WhatsApp
      </Button>
    </div>
  );
}

// ================================================================
// Meta Connect Form (legacy, behind advanced toggle)
// ================================================================
function MetaConnectForm({ onConnected }: { onConnected: () => Promise<void> }) {
  const { user } = useAuth();
  const [isConnecting, setIsConnecting] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");

  const handleConnect = async () => {
    if (!accessToken.trim() || !phoneNumberId.trim()) {
      toast.error("Access Token and Phone Number ID are required");
      return;
    }

    try {
      setIsConnecting(true);

      let { data: membership } = await supabase
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", user!.id)
        .limit(1)
        .maybeSingle();

      if (!membership) {
        const { error: wsErr } = await supabase
          .from("workspaces")
          .insert({ name: "My Workspace", plan: "free" });
        if (wsErr) throw new Error("Could not create workspace. Please contact support.");

        const { data: newMembership } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .eq("user_id", user!.id)
          .limit(1)
          .maybeSingle();
        if (!newMembership) throw new Error("Could not set up workspace membership.");
        membership = { workspace_id: newMembership.workspace_id };
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

      toast.success("WhatsApp connected (Meta)!", { description: "Legacy provider linked." });
      setAccessToken("");
      setPhoneNumberId("");
      setWabaId("");
      await onConnected();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect WhatsApp";
      toast.error("Connection failed", { description: message });
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="space-y-4 border rounded-md p-4 bg-muted/30">
      <p className="text-xs text-muted-foreground font-medium">Meta Cloud API (Legacy)</p>

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

      <Button onClick={handleConnect} disabled={isConnecting} variant="secondary">
        {isConnecting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <MessageSquare className="h-4 w-4 mr-2" />
        )}
        Connect via Meta
      </Button>
    </div>
  );
}
