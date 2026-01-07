import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, Video } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

interface OrgSettings {
  id: string;
  user_id: string;
  zoom_meeting_sync_enabled: boolean;
  zoom_auto_generate_followups_enabled: boolean;
}

export function ZoomMeetingSyncCard() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (user) {
      loadSettings();
    }
  }, [user]);

  const loadSettings = async () => {
    try {
      const { data, error } = await supabase
        .from("org_settings")
        .select("*")
        .eq("user_id", user!.id)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setSettings(data as OrgSettings);
      } else {
        // Create default settings if none exist
        const { data: newSettings, error: insertError } = await supabase
          .from("org_settings")
          .insert({
            user_id: user!.id,
            zoom_meeting_sync_enabled: true,
            zoom_auto_generate_followups_enabled: true,
          })
          .select()
          .single();

        if (insertError) throw insertError;
        setSettings(newSettings as OrgSettings);
      }
    } catch (err) {
      console.error("Failed to load org settings:", err);
      toast.error("Failed to load settings");
    } finally {
      setIsLoading(false);
    }
  };

  const updateSetting = async (key: keyof OrgSettings, value: boolean) => {
    if (!settings) return;

    setIsSaving(true);
    const previousValue = settings[key];

    // Optimistic update
    setSettings({ ...settings, [key]: value });

    try {
      const { error } = await supabase
        .from("org_settings")
        .update({ [key]: value })
        .eq("id", settings.id);

      if (error) throw error;
      toast.success("Setting saved");
    } catch (err) {
      console.error("Failed to update setting:", err);
      toast.error("Failed to save setting");
      // Rollback
      setSettings({ ...settings, [key]: previousValue });
    } finally {
      setIsSaving(false);
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
        <div className="flex items-center gap-2">
          <Video className="h-5 w-5" />
          <CardTitle className="text-lg">Zoom Meeting Sync (via Gmail)</CardTitle>
        </div>
        <CardDescription>
          Automatically detect and process Zoom meeting summary emails
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="zoom-sync-toggle" className="font-medium">
              Auto-ingest Zoom meeting summaries
            </Label>
            <p className="text-sm text-muted-foreground">
              Detects Zoom Meeting Summary emails in Gmail and creates meeting records. Never auto-sends emails.
            </p>
          </div>
          <Switch
            id="zoom-sync-toggle"
            checked={settings?.zoom_meeting_sync_enabled ?? true}
            onCheckedChange={(checked) => updateSetting("zoom_meeting_sync_enabled", checked)}
            disabled={isSaving}
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="zoom-followup-toggle" className="font-medium">
              Auto-generate follow-up drafts from summaries
            </Label>
            <p className="text-sm text-muted-foreground">
              When enabled, generates post-meeting recap + follow-up drafts from the summary. You review and send manually.
            </p>
          </div>
          <Switch
            id="zoom-followup-toggle"
            checked={settings?.zoom_auto_generate_followups_enabled ?? true}
            onCheckedChange={(checked) => updateSetting("zoom_auto_generate_followups_enabled", checked)}
            disabled={isSaving || !settings?.zoom_meeting_sync_enabled}
          />
        </div>

        {!settings?.zoom_meeting_sync_enabled && (
          <p className="text-xs text-muted-foreground italic">
            Enable Zoom meeting sync to configure follow-up generation.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
