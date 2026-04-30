import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Loader2, AlertTriangle, Clock } from "lucide-react";

// Curated IANA timezone list. Extend as needed.
const TIMEZONES: { value: string; label: string }[] = [
  { value: "America/New_York", label: "America/New_York (Eastern)" },
  { value: "America/Chicago", label: "America/Chicago (Central)" },
  { value: "America/Denver", label: "America/Denver (Mountain)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (Pacific)" },
  { value: "America/Phoenix", label: "America/Phoenix (Arizona)" },
  { value: "America/Anchorage", label: "America/Anchorage (Alaska)" },
  { value: "Pacific/Honolulu", label: "Pacific/Honolulu (Hawaii)" },
  { value: "America/Toronto", label: "America/Toronto" },
  { value: "America/Mexico_City", label: "America/Mexico_City" },
  { value: "America/Sao_Paulo", label: "America/Sao_Paulo" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "Europe/Dublin", label: "Europe/Dublin" },
  { value: "Europe/Paris", label: "Europe/Paris" },
  { value: "Europe/Berlin", label: "Europe/Berlin" },
  { value: "Europe/Madrid", label: "Europe/Madrid" },
  { value: "Europe/Amsterdam", label: "Europe/Amsterdam" },
  { value: "Europe/Stockholm", label: "Europe/Stockholm" },
  { value: "Europe/Warsaw", label: "Europe/Warsaw" },
  { value: "Europe/Athens", label: "Europe/Athens" },
  { value: "Europe/Istanbul", label: "Europe/Istanbul" },
  { value: "Asia/Jerusalem", label: "Asia/Jerusalem" },
  { value: "Asia/Dubai", label: "Asia/Dubai" },
  { value: "Asia/Karachi", label: "Asia/Karachi" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata" },
  { value: "Asia/Singapore", label: "Asia/Singapore" },
  { value: "Asia/Hong_Kong", label: "Asia/Hong_Kong" },
  { value: "Asia/Shanghai", label: "Asia/Shanghai" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
  { value: "Australia/Sydney", label: "Australia/Sydney" },
  { value: "Pacific/Auckland", label: "Pacific/Auckland" },
  { value: "UTC", label: "UTC" },
];

function getBrowserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function WorkspaceTimezoneCard() {
  const { workspaceId, workspaceRole } = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [storedTz, setStoredTz] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");

  const browserTz = useMemo(() => getBrowserTz(), []);
  const isAdmin = workspaceRole === "admin";

  // Ensure browser TZ is selectable even if not in curated list.
  const options = useMemo(() => {
    const list = [...TIMEZONES];
    if (browserTz && !list.some(o => o.value === browserTz)) {
      list.unshift({ value: browserTz, label: `${browserTz} (browser)` });
    }
    if (storedTz && !list.some(o => o.value === storedTz)) {
      list.unshift({ value: storedTz, label: storedTz });
    }
    return list;
  }, [browserTz, storedTz]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await (supabase as any)
        .from("workspaces")
        .select("timezone")
        .eq("id", workspaceId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        toast.error("Failed to load workspace timezone");
        setLoading(false);
        return;
      }
      const tz = (data?.timezone as string | null) ?? null;
      setStoredTz(tz);
      setSelected(tz || browserTz);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, browserTz]);

  const handleSave = async () => {
    if (!workspaceId || !selected) return;
    setSaving(true);
    const { error } = await (supabase as any)
      .from("workspaces")
      .update({ timezone: selected })
      .eq("id", workspaceId);
    setSaving(false);
    if (error) {
      toast.error(`Failed to save timezone: ${error.message}`);
      return;
    }
    setStoredTz(selected);
    toast.success("Workspace timezone saved");
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading timezone…
      </div>
    );
  }

  const isUnset = !storedTz;
  const isDirty = selected && selected !== storedTz;

  return (
    <div className="space-y-4">
      {isUnset && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Automation is paused until you confirm your timezone.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="workspace-tz" className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Workspace timezone
        </Label>
        <Select
          value={selected}
          onValueChange={setSelected}
          disabled={!isAdmin || saving}
        >
          <SelectTrigger id="workspace-tz">
            <SelectValue placeholder="Select a timezone" />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            {options.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Used to schedule automated sends within your business hours. Detected from your browser:{" "}
          <span className="font-mono">{browserTz}</span>.
        </p>
      </div>

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={!isAdmin || saving || !isDirty}
          size="sm"
        >
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save timezone
        </Button>
      </div>

      {!isAdmin && (
        <p className="text-xs text-muted-foreground">
          Only workspace admins can change the timezone.
        </p>
      )}
    </div>
  );
}
