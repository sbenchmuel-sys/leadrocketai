import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Building2, Loader2, Plus, X, Save } from "lucide-react";
import { toast } from "sonner";
import { 
  getWorkspaceProfile, 
  upsertWorkspaceProfile, 
  WorkspaceProfile, 
  WorkspaceProfileInput 
} from "@/lib/workspaceProfileQueries";

export function WorkspaceProfileCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<WorkspaceProfile | null>(null);
  
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
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="companyName">Company Name</Label>
            <Input
              id="companyName"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme Corp"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="productName">Product Name</Label>
            <Input
              id="productName"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="Acme SDK"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="productDescription">Product Description</Label>
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
