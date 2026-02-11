import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Building2, Loader2, Plus, X, Save, Sparkles, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { 
  getWorkspaceProfile, 
  upsertWorkspaceProfile, 
  WorkspaceProfile, 
  WorkspaceProfileInput 
} from "@/lib/workspaceProfileQueries";
import { useProfileSync, getHighConfidenceValue } from "@/hooks/useProfileSync";

interface CompanyKb {
  differentiators?: { text: string }[];
  target_customers?: { text: string }[];
  proof_points?: { text: string }[];
  company_name?: string;
  product_name?: string;
}

function extractAutoFill(profile: WorkspaceProfile) {
  const kb = (profile as any).company_kb as CompanyKb | undefined;
  const autoFilled: string[] = [];
  const values: Partial<Record<'companyName' | 'productName' | 'productDescription' | 'valueProps', any>> = {};

  if (kb && typeof kb === 'object') {
    if (!profile.company_name && kb.company_name) {
      values.companyName = kb.company_name;
      autoFilled.push('company_name');
    }
    if (!profile.product_name && kb.product_name) {
      values.productName = kb.product_name;
      autoFilled.push('product_name');
    }
    if (!profile.product_description) {
      const diffs = kb.differentiators?.map(d => d.text).filter(Boolean) || [];
      const targets = kb.target_customers?.map(t => t.text).filter(Boolean) || [];
      if (diffs.length > 0 && targets.length > 0) {
        values.productDescription = `Target customers: ${targets.join(', ')}. Key differentiators: ${diffs.join('; ')}.`;
        autoFilled.push('product_description');
      }
    }
  }

  if ((!profile.primary_value_props || profile.primary_value_props.length === 0)) {
    const vp = (profile as any).primary_value_props;
    // value props from onboarding are already on the profile row — handled by normal load
  }

  return { values, autoFilled };
}

export function WorkspaceProfileCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<WorkspaceProfile | null>(null);
  const [autoFilledFields, setAutoFilledFields] = useState<string[]>([]);
  const { isSyncing, syncFromKB } = useProfileSync();
  
  // Form state
  const [companyName, setCompanyName] = useState("");
  const [productName, setProductName] = useState("");
  const [productDescription, setProductDescription] = useState("");
  const [pricingPolicy, setPricingPolicy] = useState<'no_pricing_in_email' | 'pricing_allowed'>('no_pricing_in_email');
  const [meetingTimezone, setMeetingTimezone] = useState("");
  const [valueProps, setValueProps] = useState<string[]>([]);
  const [newValueProp, setNewValueProp] = useState("");

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    try {
      const data = await getWorkspaceProfile();
      setProfile(data);
      if (data) {
        setCompanyName(data.company_name || "");
        setProductName(data.product_name || "");
        setProductDescription(data.product_description || "");
        setPricingPolicy(data.pricing_policy);
        setMeetingTimezone(data.meeting_timezone || "");
        setValueProps(data.primary_value_props || []);

        // Auto-fill empty fields from knowledge base
        const { values, autoFilled } = extractAutoFill(data);
        if (values.companyName) setCompanyName(values.companyName);
        if (values.productName) setProductName(values.productName);
        if (values.productDescription) setProductDescription(values.productDescription);
        setAutoFilledFields(autoFilled);
      }
    } catch (err) {
      console.error("Failed to load workspace profile:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const input: WorkspaceProfileInput = {
        company_name: companyName.trim() || null,
        product_name: productName.trim() || null,
        product_description: productDescription.trim() || null,
        pricing_policy: pricingPolicy,
        meeting_timezone: meetingTimezone.trim() || null,
        primary_value_props: valueProps,
      };
      
      await upsertWorkspaceProfile(input);
      toast.success("Workspace profile saved");
      await loadProfile();
    } catch (err) {
      console.error("Failed to save workspace profile:", err);
      toast.error("Failed to save workspace profile");
    } finally {
      setSaving(false);
    }
  }

  function addValueProp() {
    if (newValueProp.trim() && !valueProps.includes(newValueProp.trim())) {
      setValueProps([...valueProps, newValueProp.trim()]);
      setNewValueProp("");
    }
  }

  function removeValueProp(prop: string) {
    setValueProps(valueProps.filter(p => p !== prop));
  }

  if (loading) {
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
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          Workspace Profile
        </CardTitle>
        <CardDescription>
          Configure your company and product information for AI-generated emails
        </CardDescription>
        {autoFilledFields.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Some fields were auto-filled from your knowledge base. Review and save to confirm.
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          disabled={isSyncing}
          onClick={async () => {
            const result = await syncFromKB("workspace");
            if (!result?.workspace) {
              toast.info("No workspace data found in knowledge base");
              return;
            }
            const ws = result.workspace;
            const filled: string[] = [];
            const v = getHighConfidenceValue;
            if (!companyName && v(ws.company_name)) { setCompanyName(v(ws.company_name)!); filled.push("company_name"); }
            if (!productName && v(ws.product_name)) { setProductName(v(ws.product_name)!); filled.push("product_name"); }
            if (!productDescription && v(ws.product_description)) { setProductDescription(v(ws.product_description)!); filled.push("product_description"); }
            if (valueProps.length === 0 && v(ws.primary_value_props)) { setValueProps(v(ws.primary_value_props)!); filled.push("value_props"); }
            if (!meetingTimezone && v(ws.meeting_timezone)) { setMeetingTimezone(v(ws.meeting_timezone)!); filled.push("timezone"); }
            if (filled.length > 0) {
              setAutoFilledFields(prev => [...prev, ...filled]);
              toast.success(`Synced ${filled.length} field(s) from knowledge base. Review and save.`);
            } else {
              toast.info("All fields already populated or no high-confidence data found.");
            }
          }}
        >
          {isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Sync from KB
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="companyName" className="flex items-center gap-1.5">
              Company Name
              {autoFilledFields.includes('company_name') && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">auto-filled</Badge>}
            </Label>
            <Input
              id="companyName"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme Corp"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="productName" className="flex items-center gap-1.5">
              Product Name
              {autoFilledFields.includes('product_name') && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">auto-filled</Badge>}
            </Label>
            <Input
              id="productName"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="Acme SDK"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="productDescription" className="flex items-center gap-1.5">
            Product Description
            {autoFilledFields.includes('product_description') && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">auto-filled</Badge>}
          </Label>
          <Textarea
            id="productDescription"
            value={productDescription}
            onChange={(e) => setProductDescription(e.target.value)}
            placeholder="Brief description of your product (2-5 sentences)"
            rows={3}
          />
        </div>

        <div className="space-y-2">
          <Label>Value Propositions</Label>
          <div className="flex flex-wrap gap-2 mb-2">
            {valueProps.map((prop, idx) => (
              <Badge key={idx} variant="secondary" className="gap-1 pr-1">
                {prop}
                <button 
                  onClick={() => removeValueProp(prop)}
                  className="ml-1 hover:bg-muted-foreground/20 rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={newValueProp}
              onChange={(e) => setNewValueProp(e.target.value)}
              placeholder="Add a value proposition"
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addValueProp())}
            />
            <Button type="button" variant="outline" size="icon" onClick={addValueProp}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="pricingPolicy">Pricing Policy</Label>
            <Select value={pricingPolicy} onValueChange={(v) => setPricingPolicy(v as any)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no_pricing_in_email">
                  No pricing in emails (recommend)
                </SelectItem>
                <SelectItem value="pricing_allowed">
                  Pricing allowed in emails
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              When set to "no pricing", AI will offer to discuss pricing on a call instead
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="meetingTimezone">Preferred Timezone</Label>
            <Input
              id="meetingTimezone"
              value={meetingTimezone}
              onChange={(e) => setMeetingTimezone(e.target.value)}
              placeholder="America/New_York"
            />
            <p className="text-xs text-muted-foreground">
              IANA timezone for meeting suggestions
            </p>
          </div>
        </div>

        <div className="flex justify-end pt-4">
          <Button onClick={handleSave} disabled={saving} className="gap-2">
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Workspace Profile
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
