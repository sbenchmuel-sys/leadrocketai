import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save, User, RefreshCw, Phone } from "lucide-react";
import { toast } from "sonner";
import { getRepProfile, upsertRepProfile, RepProfile } from "@/lib/repProfileQueries";
import { useProfileSync, getHighConfidenceValue } from "@/hooks/useProfileSync";

export function RepProfileCard() {
  const [profile, setProfile] = useState<RepProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { isSyncing, syncFromKB } = useProfileSync();

  // Form state
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [calendarLink, setCalendarLink] = useState("");
  const [officeAddress, setOfficeAddress] = useState("");
  const [twilioPhoneNumber, setTwilioPhoneNumber] = useState("");

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    try {
      const data = await getRepProfile();
      setProfile(data);
      if (data) {
        setFullName(data.full_name || "");
        setEmail(data.email || "");
        setPhone(data.phone || "");
        setJobTitle(data.job_title || "");
        setCompanyName(data.company_name || "");
        setLinkedinUrl(data.linkedin_url || "");
        setCalendarLink(data.calendar_link || "");
        setOfficeAddress(data.office_address || "");
        setTwilioPhoneNumber((data as any).twilio_phone_number || "");
      }
    } catch (err) {
      console.error("Failed to load rep profile:", err);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    setIsSaving(true);
    try {
      await upsertRepProfile({
        full_name: fullName.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        job_title: jobTitle.trim() || null,
        company_name: companyName.trim() || null,
        linkedin_url: linkedinUrl.trim() || null,
        calendar_link: calendarLink.trim() || null,
        office_address: officeAddress.trim() || null,
        twilio_phone_number: twilioPhoneNumber.trim() || null,
      });
      toast.success("Profile saved successfully");
      loadProfile();
    } catch (err) {
      console.error("Failed to save profile:", err);
      toast.error("Failed to save profile");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          disabled={isSyncing}
          onClick={async () => {
            const result = await syncFromKB("rep_profile");
            if (!result?.rep_profile) {
              toast.info("No profile data found in knowledge base or emails");
              return;
            }
            const rp = result.rep_profile;
            const v = getHighConfidenceValue;
            let count = 0;
            if (!fullName && v(rp.full_name)) { setFullName(v(rp.full_name)!); count++; }
            if (!email && v(rp.email)) { setEmail(v(rp.email)!); count++; }
            if (!phone && v(rp.phone)) { setPhone(v(rp.phone)!); count++; }
            if (!jobTitle && v(rp.job_title)) { setJobTitle(v(rp.job_title)!); count++; }
            if (!companyName && v(rp.company_name)) { setCompanyName(v(rp.company_name)!); count++; }
            if (!linkedinUrl && v(rp.linkedin_url)) { setLinkedinUrl(v(rp.linkedin_url)!); count++; }
            if (!calendarLink && v(rp.calendar_link)) { setCalendarLink(v(rp.calendar_link)!); count++; }
            if (!officeAddress && v(rp.office_address)) { setOfficeAddress(v(rp.office_address)!); count++; }
            if (count > 0) {
              toast.success(`Synced ${count} field(s). Review and save.`);
            } else {
              toast.info("All fields already populated or no high-confidence data found.");
            }
          }}
        >
          {isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Sync from KB & Emails
        </Button>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="fullName">Full Name</Label>
            <Input
              id="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="John Smith"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@company.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 (555) 123-4567"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="jobTitle">Job Title</Label>
            <Input
              id="jobTitle"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Senior Account Executive"
            />
          </div>
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
            <Label htmlFor="linkedinUrl">LinkedIn URL</Label>
            <Input
              id="linkedinUrl"
              value={linkedinUrl}
              onChange={(e) => setLinkedinUrl(e.target.value)}
              placeholder="https://linkedin.com/in/johnsmith"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="calendarLink">Calendar Link</Label>
            <Input
              id="calendarLink"
              value={calendarLink}
              onChange={(e) => setCalendarLink(e.target.value)}
              placeholder="https://calendly.com/johnsmith"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="officeAddress">Office Address</Label>
            <Input
              id="officeAddress"
              value={officeAddress}
              onChange={(e) => setOfficeAddress(e.target.value)}
              placeholder="123 Main St, Suite 100, City, ST 12345"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Profile
          </Button>
        </div>
    </div>
  );
}
