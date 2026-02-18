import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Zap, Shield, Info } from "lucide-react";

const MODE_LABELS: Record<string, { label: string; description: string }> = {
  manual: {
    label: "Manual Only",
    description: "All replies require human review. No automation.",
  },
  suggest_only: {
    label: "Suggest Only",
    description: "AI drafts suggestions but never sends automatically.",
  },
  hybrid: {
    label: "Hybrid",
    description: "Auto-send on safe intents above confidence threshold.",
  },
  full_auto: {
    label: "Full Auto",
    description: "Auto-send all replies (except blocked keywords/safety rules).",
  },
};

export function WhatsAppAutomationCard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [settingsId, setSettingsId] = useState<string | null>(null);

  const [defaultMode, setDefaultMode] = useState("suggest_only");
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.85);
  const [afterHoursAuto, setAfterHoursAuto] = useState(false);
  const [weekendAuto, setWeekendAuto] = useState(false);

  useEffect(() => {
    if (!user) return;
    loadSettings();
  }, [user]);

  async function loadSettings() {
    setLoading(true);
    try {
      // Resolve workspace
      const { data: member } = await supabase
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", user!.id)
        .maybeSingle();

      if (!member?.workspace_id) {
        setLoading(false);
        return;
      }

      setWorkspaceId(member.workspace_id);

      const { data: settings } = await (supabase as any)
        .from("workspace_automation_settings")
        .select("*")
        .eq("workspace_id", member.workspace_id)
        .maybeSingle();

      if (settings) {
        setSettingsId(settings.id);
        setDefaultMode(settings.default_mode ?? "suggest_only");
        setConfidenceThreshold(settings.confidence_threshold ?? 0.85);
        setAfterHoursAuto(settings.after_hours_auto ?? false);
        setWeekendAuto(settings.weekend_auto ?? false);
      }
    } catch (err) {
      console.error("[WhatsAppAutomationCard] Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!workspaceId) return;
    setSaving(true);
    try {
      const payload = {
        workspace_id: workspaceId,
        default_mode: defaultMode,
        confidence_threshold: confidenceThreshold,
        after_hours_auto: afterHoursAuto,
        weekend_auto: weekendAuto,
        updated_at: new Date().toISOString(),
      };

      if (settingsId) {
        await (supabase as any)
          .from("workspace_automation_settings")
          .update(payload)
          .eq("id", settingsId);
      } else {
        const { data } = await (supabase as any)
          .from("workspace_automation_settings")
          .insert(payload)
          .select("id")
          .single();
        if (data?.id) setSettingsId(data.id);
      }

      toast.success("WhatsApp automation policy saved");
    } catch (err) {
      console.error("[WhatsAppAutomationCard] Save failed:", err);
      toast.error("Failed to save automation policy");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading automation settings…</span>
      </div>
    );
  }

  const modeInfo = MODE_LABELS[defaultMode];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/40 border border-border/50">
        <Shield className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          These settings control when the AI can automatically send WhatsApp replies on behalf of your team. 
          Per-lead overrides always take priority over workspace defaults.
        </p>
      </div>

      {/* Default Mode */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Default Automation Mode</Label>
        <Select value={defaultMode} onValueChange={setDefaultMode}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(MODE_LABELS).map(([value, { label }]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {modeInfo && (
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3 w-3 mt-0.5 shrink-0" />
            {modeInfo.description}
          </p>
        )}
      </div>

      {/* Confidence Threshold (only relevant for hybrid) */}
      {(defaultMode === "hybrid" || defaultMode === "full_auto") && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Confidence Threshold</Label>
            <span className="text-sm font-mono text-foreground tabular-nums">
              {Math.round(confidenceThreshold * 100)}%
            </span>
          </div>
          <Slider
            min={50}
            max={99}
            step={1}
            value={[Math.round(confidenceThreshold * 100)]}
            onValueChange={([v]) => setConfidenceThreshold(v / 100)}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            AI must be at least this confident before auto-sending in Hybrid mode.
          </p>
        </div>
      )}

      {/* After Hours & Weekend */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">Send Windows</Label>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">After Hours Auto-Send</p>
              <p className="text-xs text-muted-foreground">Allow auto-send outside 9am–6pm</p>
            </div>
            <Switch checked={afterHoursAuto} onCheckedChange={setAfterHoursAuto} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Weekend Auto-Send</p>
              <p className="text-xs text-muted-foreground">Allow auto-send on Saturdays & Sundays</p>
            </div>
            <Switch checked={weekendAuto} onCheckedChange={setWeekendAuto} />
          </div>
        </div>
      </div>

      {/* Safety Note */}
      <div className="flex items-start gap-2 text-xs text-muted-foreground bg-warning/5 border border-warning/20 rounded-md p-3">
        <Zap className="h-3 w-3 mt-0.5 shrink-0 text-warning" />
        <span>
          Auto-send is always blocked for: unsubscribe requests, messages under 3 characters,
          AI confidence below 70%, and messages containing blocked keywords (contract, lawyer, refund, etc.).
        </span>
      </div>

      <Button onClick={handleSave} disabled={saving} size="sm">
        {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
        Save Policy
      </Button>
    </div>
  );
}
