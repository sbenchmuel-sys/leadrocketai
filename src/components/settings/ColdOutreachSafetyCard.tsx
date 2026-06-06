import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Loader2, AlertTriangle, MapPin, Send } from "lucide-react";

// Cold-outreach safety controls (Outreach Unit C, PR 1):
//  - Company mailing address for the CAN-SPAM footer (user-entered, required).
//  - The per-workspace cold AUTO-send gate (OFF by default).
// Both gate AUTOMATIC cold email only. Building / enrolling / review-mode / all
// manual touches work regardless. The executor (PR 2) is the real enforcer; this
// card is where a rep/admin sets these and sees, honestly, why automatic sending
// is still blocked.
export function ColdOutreachSafetyCard() {
  const { workspaceId, workspaceRole } = useWorkspace();
  const isAdmin = workspaceRole === "admin";

  const [loading, setLoading] = useState(true);
  const [savingAddress, setSavingAddress] = useState(false);
  const [savingGate, setSavingGate] = useState(false);

  const [storedAddress, setStoredAddress] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [timezoneSet, setTimezoneSet] = useState<boolean>(false);

  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [autoSend, setAutoSend] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: ws }, { data: settings }] = await Promise.all([
        (supabase as any)
          .from("workspaces")
          .select("cold_outreach_postal_address, timezone")
          .eq("id", workspaceId)
          .maybeSingle(),
        (supabase as any)
          .from("workspace_automation_settings")
          .select("id, cold_auto_send_enabled")
          .eq("workspace_id", workspaceId)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      const addr = (ws?.cold_outreach_postal_address as string | null) ?? "";
      setStoredAddress(addr);
      setAddress(addr);
      setTimezoneSet(!!ws?.timezone);
      if (settings) {
        setSettingsId(settings.id);
        setAutoSend(settings.cold_auto_send_enabled ?? false);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  const handleSaveAddress = async () => {
    if (!workspaceId) return;
    setSavingAddress(true);
    const { error } = await (supabase as any)
      .from("workspaces")
      .update({ cold_outreach_postal_address: address.trim() || null })
      .eq("id", workspaceId);
    setSavingAddress(false);
    if (error) {
      toast.error(`Couldn't save the address: ${error.message}`);
      return;
    }
    setStoredAddress(address.trim());
    toast.success("Company mailing address saved");
  };

  const handleToggleAutoSend = async (next: boolean) => {
    if (!workspaceId) return;
    setSavingGate(true);
    const payload = {
      workspace_id: workspaceId,
      cold_auto_send_enabled: next,
      updated_at: new Date().toISOString(),
    };
    let error;
    if (settingsId) {
      ({ error } = await (supabase as any)
        .from("workspace_automation_settings")
        .update(payload)
        .eq("id", settingsId));
    } else {
      const res = await (supabase as any)
        .from("workspace_automation_settings")
        .insert(payload)
        .select("id")
        .single();
      error = res.error;
      if (res.data?.id) setSettingsId(res.data.id);
    }
    setSavingGate(false);
    if (error) {
      toast.error(`Couldn't update the setting: ${error.message}`);
      return;
    }
    setAutoSend(next);
    toast.success(next ? "Automatic cold sending turned on" : "Automatic cold sending turned off");
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading outreach safety settings…
      </div>
    );
  }

  const addressMissing = !storedAddress.trim();
  const addressDirty = address.trim() !== storedAddress.trim();
  // Automatic cold email cannot actually send until BOTH a postal address and a
  // workspace timezone are set — surface that honestly even if the toggle is on.
  const blockers: string[] = [];
  if (addressMissing) blockers.push("a company mailing address");
  if (!timezoneSet) blockers.push("a workspace timezone");

  return (
    <div className="space-y-6">
      {/* Company mailing address (CAN-SPAM) */}
      <div className="space-y-2">
        <Label htmlFor="cold-postal" className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-muted-foreground" />
          Company mailing address
        </Label>
        <Textarea
          id="cold-postal"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          disabled={!isAdmin || savingAddress}
          rows={3}
          placeholder={"Acme Inc.\n123 Main St, Suite 100\nAustin, TX 78701, USA"}
        />
        <p className="text-xs text-muted-foreground">
          Shown at the bottom of every cold outreach email. The law requires a real
          physical address — cold sending stays off until this is filled in.
        </p>
        <div className="flex justify-end">
          <Button onClick={handleSaveAddress} disabled={!isAdmin || savingAddress || !addressDirty} size="sm">
            {savingAddress && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save address
          </Button>
        </div>
      </div>

      {/* Cold auto-send gate */}
      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium flex items-center gap-2">
              <Send className="h-4 w-4 text-muted-foreground" />
              Send cold emails automatically
            </p>
            <p className="text-xs text-muted-foreground">
              Off: you approve each cold email in the Outreach list. On: cold emails
              send on schedule, with all the usual safety checks.
            </p>
          </div>
          <Switch
            checked={autoSend}
            onCheckedChange={handleToggleAutoSend}
            disabled={!isAdmin || savingGate}
          />
        </div>

        {autoSend && blockers.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Automatic cold sending is still paused until you add {blockers.join(" and ")}.
              Until then, cold emails wait for you to approve them.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {!isAdmin && (
        <p className="text-xs text-muted-foreground">
          Only workspace admins can change these settings.
        </p>
      )}
    </div>
  );
}
