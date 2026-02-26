import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Save, Info } from "lucide-react";

interface CallSettings {
  id: string;
  transcribe_min_duration_sec: number;
  analyze_min_duration_sec: number;
  default_language: string;
  supported_languages: string[];
  recording_notice_enabled: boolean;
  recording_require_dtmf_consent: boolean;
  audio_retention_days: number;
}

const DEFAULTS: Omit<CallSettings, "id"> = {
  transcribe_min_duration_sec: 10,
  analyze_min_duration_sec: 30,
  default_language: "en-US",
  supported_languages: ["en-US", "es-US", "fr-CA"],
  recording_notice_enabled: true,
  recording_require_dtmf_consent: false,
  audio_retention_days: 90,
};

interface CallSettingsCardProps {
  workspaceId?: string;
}

export function CallSettingsCard({ workspaceId }: CallSettingsCardProps) {
  const [settings, setSettings] = useState<CallSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [langInput, setLangInput] = useState("");

  useEffect(() => {
    if (workspaceId) loadSettings(workspaceId);
  }, [workspaceId]);

  const loadSettings = async (wsId: string) => {
    try {
      const { data: existing } = await supabase
        .from("call_settings")
        .select("*")
        .eq("workspace_id", wsId)
        .maybeSingle();

      if (existing) {
        setSettings(existing as unknown as CallSettings);
      } else {
        const { data: created } = await supabase
          .from("call_settings")
          .insert({ workspace_id: wsId, ...DEFAULTS })
          .select("*")
          .single();
        if (created) setSettings(created as unknown as CallSettings);
      }
    } catch (err) {
      console.error("Failed to load call settings", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("call_settings")
        .update({
          transcribe_min_duration_sec: Math.max(0, settings.transcribe_min_duration_sec),
          analyze_min_duration_sec: Math.max(0, settings.analyze_min_duration_sec),
          default_language: settings.default_language,
          supported_languages: settings.supported_languages,
          recording_notice_enabled: settings.recording_notice_enabled,
          recording_require_dtmf_consent: settings.recording_require_dtmf_consent,
          audio_retention_days: Math.max(1, settings.audio_retention_days),
        })
        .eq("id", settings.id);

      if (error) throw error;
      toast.success("Call settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const addLanguage = () => {
    if (!langInput.trim() || !settings) return;
    if (settings.supported_languages.includes(langInput.trim())) {
      setLangInput("");
      return;
    }
    setSettings({
      ...settings,
      supported_languages: [...settings.supported_languages, langInput.trim()],
    });
    setLangInput("");
  };

  const removeLanguage = (lang: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      supported_languages: settings.supported_languages.filter(l => l !== lang),
    });
  };

  if (!workspaceId) return <p className="text-sm text-muted-foreground py-4">No workspace selected</p>;
  if (isLoading) return <p className="text-sm text-muted-foreground py-4">Loading...</p>;
  if (!settings) return <p className="text-sm text-muted-foreground py-4">Unable to load settings</p>;

  return (
    <div className="space-y-6">
      {/* Cost Controls Info */}
      <div className="flex items-start gap-2 bg-accent/50 rounded-lg p-3">
        <Info className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
        <div className="text-xs text-muted-foreground space-y-1">
          <p><strong>Cost Controls:</strong> Transcription only runs for calls longer than the minimum duration threshold. Analysis requires an even longer minimum. Adjust these to control usage costs.</p>
        </div>
      </div>

      {/* Duration Thresholds */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Min Duration for Transcription (sec)</Label>
          <Input
            type="number"
            min={0}
            value={settings.transcribe_min_duration_sec}
            onChange={e => setSettings({ ...settings, transcribe_min_duration_sec: parseInt(e.target.value) || 0 })}
          />
        </div>
        <div className="space-y-2">
          <Label>Min Duration for Analysis (sec)</Label>
          <Input
            type="number"
            min={0}
            value={settings.analyze_min_duration_sec}
            onChange={e => setSettings({ ...settings, analyze_min_duration_sec: parseInt(e.target.value) || 0 })}
          />
        </div>
      </div>

      {/* Language */}
      <div className="space-y-2">
        <Label>Default Language</Label>
        <Input
          value={settings.default_language}
          onChange={e => setSettings({ ...settings, default_language: e.target.value })}
          placeholder="e.g. en-US"
        />
      </div>

      <div className="space-y-2">
        <Label>Supported Languages</Label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {settings.supported_languages.map(lang => (
            <Badge
              key={lang}
              variant="outline"
              className="text-xs cursor-pointer hover:bg-destructive/10"
              onClick={() => removeLanguage(lang)}
            >
              {lang} ×
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={langInput}
            onChange={e => setLangInput(e.target.value)}
            placeholder="Add language (e.g. pt-BR)"
            onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addLanguage())}
          />
          <Button variant="outline" size="sm" onClick={addLanguage}>Add</Button>
        </div>
      </div>

      {/* Recording */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label>Recording Notice</Label>
            <p className="text-xs text-muted-foreground">Play automated notice at start of call</p>
          </div>
          <Switch
            checked={settings.recording_notice_enabled}
            onCheckedChange={v => setSettings({ ...settings, recording_notice_enabled: v })}
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label>Require DTMF Consent</Label>
            <p className="text-xs text-muted-foreground">Require caller to press key to consent</p>
          </div>
          <Switch
            checked={settings.recording_require_dtmf_consent}
            onCheckedChange={v => setSettings({ ...settings, recording_require_dtmf_consent: v })}
          />
        </div>
      </div>

      {/* Retention */}
      <div className="space-y-2">
        <Label>Audio Retention (days)</Label>
        <Input
          type="number"
          min={1}
          value={settings.audio_retention_days}
          onChange={e => setSettings({ ...settings, audio_retention_days: parseInt(e.target.value) || 90 })}
        />
      </div>

      <Button onClick={handleSave} disabled={isSaving}>
        <Save className="h-4 w-4 mr-1" />
        {isSaving ? "Saving..." : "Save Settings"}
      </Button>
    </div>
  );
}
