import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { ListEditor } from "@/components/leads/DismissedListsDialog";

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;

export function LeadDetectionCard() {
  const { workspaceId } = useWorkspace();
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [initialDays, setInitialDays] = useState<number>(DEFAULT_DAYS);
  const [allowPersonalDomains, setAllowPersonalDomains] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const load = async () => {
      setLoading(true);

      // Load lookback days (established column — hard error if missing)
      const { data, error } = await supabase
        .from("workspaces")
        .select("lookback_seed_window_days" as any)
        .eq("id", workspaceId)
        .maybeSingle();
      if (!active) return;
      if (error) {
        toast.error("Failed to load lead detection settings");
      } else {
        const v = Number((data as any)?.lookback_seed_window_days ?? DEFAULT_DAYS);
        setDays(v);
        setInitialDays(v);
      }

      // Load allow_personal_domains separately — silently defaults to false if
      // the migration hasn't been applied yet (column doesn't exist).
      const { data: pd } = await supabase
        .from("workspaces")
        .select("allow_personal_domains" as any)
        .eq("id", workspaceId)
        .maybeSingle();
      if (!active) return;
      setAllowPersonalDomains((pd as any)?.allow_personal_domains ?? false);

      setLoading(false);
    };
    load();
    return () => { active = false; };
  }, [workspaceId]);

  const handleSaveDays = async () => {
    if (!workspaceId) return;
    if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
      toast.error(`Enter a whole number between ${MIN_DAYS} and ${MAX_DAYS}`);
      return;
    }
    setSaving(true);
    const prev = initialDays;
    setInitialDays(days);
    const { error } = await supabase
      .from("workspaces")
      .update({ lookback_seed_window_days: days } as any)
      .eq("id", workspaceId);
    setSaving(false);
    if (error) {
      setInitialDays(prev);
      toast.error(error.message || "Failed to save");
      return;
    }
    toast.success("Saved");
  };

  const handleTogglePersonalDomains = async (checked: boolean) => {
    if (!workspaceId) return;
    setSavingToggle(true);
    const prev = allowPersonalDomains;
    setAllowPersonalDomains(checked); // optimistic
    const { error } = await supabase
      .from("workspaces")
      .update({ allow_personal_domains: checked } as any)
      .eq("id", workspaceId);
    setSavingToggle(false);
    if (error) {
      setAllowPersonalDomains(prev);
      toast.error(error.message || "Failed to save");
      return;
    }
    toast.success(checked ? "Personal domains enabled" : "Personal domains disabled");
  };

  const dirty = days !== initialDays;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead Detection</CardTitle>
        <CardDescription>
          Control how new prospects are auto-suggested from your inbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <div className="space-y-2 max-w-sm">
          <Label htmlFor="lookback-days">Lookback window (days)</Label>
          <div className="flex gap-2">
            <Input
              id="lookback-days"
              type="number"
              min={MIN_DAYS}
              max={MAX_DAYS}
              value={loading ? "" : days}
              disabled={loading || saving}
              onChange={(e) => setDays(parseInt(e.target.value, 10) || 0)}
            />
            <Button onClick={handleSaveDays} disabled={!dirty || saving || loading}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            When you connect a new mailbox, we'll scan this many days back to seed your Pending Leads.
          </p>
        </div>

        <Separator />

        <div className="flex items-center justify-between max-w-sm">
          <div className="space-y-0.5">
            <Label>Allow personal email domains</Label>
            <p className="text-sm text-muted-foreground">
              Surface prospects using Gmail, Yahoo, Outlook, etc. as their work email.
              Useful for markets where personal email is common for business (SE Asia, India, startups).
            </p>
          </div>
          {savingToggle ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground ml-4" />
          ) : (
            <Switch
              checked={allowPersonalDomains}
              disabled={loading}
              onCheckedChange={handleTogglePersonalDomains}
              className="ml-4"
            />
          )}
        </div>

        <Separator />

        <ListEditor
          kind="internal"
          title="Internal team domains"
          description="Emails to these domains are treated as teammates and skipped."
          placeholder="yourcompany.com"
        />

        <Separator />

        <ListEditor
          kind="domain"
          title="Always reject from these domains"
          description="Emails from these domains will never be suggested as leads."
          placeholder="example.com"
        />

        <Separator />

        <ListEditor
          kind="email"
          title="Always reject these emails"
          description="Specific addresses that should never be suggested."
          placeholder="noreply@example.com"
        />
      </CardContent>
    </Card>
  );
}
