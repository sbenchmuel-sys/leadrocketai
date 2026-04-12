import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { toast } from "sonner";
import { Loader2, MessageSquare, Save } from "lucide-react";

const E164_RE = /^\+[1-9]\d{6,14}$/;

export function SmsSettingsCard() {
  const { workspaceId } = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [defaultNumber, setDefaultNumber] = useState("");

  useEffect(() => {
    if (!workspaceId) return;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("workspaces")
        .select("sms_enabled, default_sms_number")
        .eq("id", workspaceId)
        .single();
      if (data) {
        setSmsEnabled(data.sms_enabled ?? false);
        setDefaultNumber(data.default_sms_number ?? "");
      }
      setLoading(false);
    })();
  }, [workspaceId]);

  const handleSave = async () => {
    if (!workspaceId) return;
    if (smsEnabled && defaultNumber && !E164_RE.test(defaultNumber)) {
      toast.error("Enter a valid E.164 phone number (e.g. +15551234567)");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("workspaces")
      .update({
        sms_enabled: smsEnabled,
        default_sms_number: defaultNumber || null,
      })
      .eq("id", workspaceId);

    if (error) {
      toast.error("Failed to save SMS settings");
    } else {
      toast.success("SMS settings saved");
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              SMS Configuration
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Enable SMS outreach via Twilio. Leads must have a phone number and SMS opt-in.
            </CardDescription>
          </div>
          <Badge variant={smsEnabled ? "default" : "secondary"} className="text-xs">
            {smsEnabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="sms-toggle" className="text-sm">Enable SMS channel</Label>
          <Switch
            id="sms-toggle"
            checked={smsEnabled}
            onCheckedChange={setSmsEnabled}
          />
        </div>

        {smsEnabled && (
          <div className="space-y-2">
            <Label htmlFor="sms-number" className="text-sm">Default Twilio SMS Number</Label>
            <Input
              id="sms-number"
              placeholder="+15551234567"
              value={defaultNumber}
              onChange={(e) => setDefaultNumber(e.target.value)}
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              Your Twilio phone number for outbound SMS. Must be in E.164 format.
            </p>
          </div>
        )}

        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
