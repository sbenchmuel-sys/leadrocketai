import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import { createLead, setOnboardingStep } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, ArrowLeft, Upload, FileSpreadsheet, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import Papa from "papaparse";

interface CreateLeadStepProps {
  onNext: () => void;
  onBack: () => void;
}

interface ParsedLead {
  name: string;
  company: string;
  email: string;
  job_title?: string;
  phone?: string;
  industry?: string;
  country?: string;
}

type InputMode = "choose" | "manual" | "upload";

export default function CreateLeadStep({ onNext, onBack }: CreateLeadStepProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<InputMode>("choose");
  const [formData, setFormData] = useState({
    name: "",
    company: "",
    email: "",
    motion: "outbound_prospecting" as string,
  });

  const [parsedLeads, setParsedLeads] = useState<ParsedLead[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.company.trim() || !formData.email.trim()) {
      toast.error("Please fill in all fields");
      return;
    }
    setIsLoading(true);
    try {
      await createLead({
        name: formData.name,
        company: formData.company,
        email: formData.email,
        motion: formData.motion,
      });
      await setOnboardingStep(4);
      toast.success("Lead created successfully!");
      onNext();
    } catch (err) {
      console.error("Failed to create lead:", err);
      toast.error("Failed to create lead. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const leads: ParsedLead[] = results.data.map((row) => {
          const firstName = (row["First Name"] || row["FirstName"] || row["first_name"] || "").trim();
          const lastName = (row["Last Name"] || row["LastName"] || row["last_name"] || "").trim();
          const name = firstName && lastName
            ? `${firstName} ${lastName}`
            : (row["Name"] || row["name"] || firstName || "Unknown").trim();
          const company = (row["Company Name"] || row["Company"] || row["company"] || row["company_name"] || "").trim();
          const email = (row["Email"] || row["email"] || row["Email Address"] || "").trim().toLowerCase();
          return {
            name,
            company: company || "Unknown Company",
            email: email || "",
            job_title: (row["Job Title"] || row["Title"] || row["job_title"] || "").trim() || undefined,
            phone: (row["Phone Number"] || row["Phone"] || row["phone"] || "").trim() || undefined,
            industry: (row["Industry"] || row["industry"] || "").trim() || undefined,
            country: (row["Country/Region"] || row["Country"] || row["country"] || "").trim() || undefined,
          };
        });

        const validLeads = leads.filter((lead) => lead.email && lead.email.includes("@"));
        setParsedLeads(validLeads);
        if (validLeads.length === 0) {
          toast.error("No valid leads found. Make sure there's an Email column.");
        } else {
          toast.success(`Found ${validLeads.length} leads to import`);
        }
      },
      error: (err) => {
        console.error("Failed to parse file:", err);
        toast.error("Failed to parse file. Please check the format.");
        setParsedLeads([]);
      },
    });
  };

  const handleFileImport = async () => {
    if (parsedLeads.length === 0) return;
    setIsLoading(true);
    try {
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (authErr || !user) throw new Error("Not logged in");
      const leadsToInsert = parsedLeads.map((lead) => ({
        ...lead,
        owner_user_id: user.id,
        source_type: "csv_import",
        motion: "outbound_prospecting",
        strategy: "fast" as const,
        last_activity_at: new Date().toISOString(),
      }));
      const { error } = await supabase.from("leads").insert(leadsToInsert);
      if (error) throw error;
      await setOnboardingStep(4);
      toast.success(`Imported ${parsedLeads.length} leads!`);
      onNext();
    } catch (err) {
      console.error("Import failed:", err);
      toast.error(err instanceof Error ? err.message : "Failed to import leads");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3 text-center">
        <h2 className="text-3xl font-semibold text-foreground tracking-tight">Add Your First Lead</h2>
        <p className="text-muted-foreground text-[15px] leading-relaxed">
          Start by adding a prospect you're currently working with.
        </p>
      </div>

      {mode === "choose" && (
        <>
          <div className="flex flex-col gap-3 max-w-sm mx-auto">
            <button
              type="button"
              onClick={() => setMode("manual")}
              className="flex items-center gap-4 p-5 rounded-2xl border border-border bg-card hover:border-primary/40 hover:shadow-[0_0_20px_hsl(217_91%_60%/0.08)] transition-all cursor-pointer text-left"
            >
              <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <UserPlus className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="font-medium text-foreground text-[15px]">Create Lead</p>
                <p className="text-sm text-muted-foreground">Add a single contact manually</p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setMode("upload");
                setTimeout(() => fileInputRef.current?.click(), 100);
              }}
              className="flex items-center gap-4 p-4 rounded-2xl border border-border bg-card hover:border-muted-foreground/20 transition-all cursor-pointer text-left"
            >
              <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
                <FileSpreadsheet className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium text-foreground text-sm">Import CSV</p>
                <p className="text-xs text-muted-foreground">Bulk import from a spreadsheet</p>
              </div>
            </button>
          </div>

          {/* Mini CRM preview */}
          <div className="max-w-sm mx-auto rounded-2xl border border-border bg-muted/20 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Your Pipeline Preview</p>
            </div>
            <div className="divide-y divide-border">
              {[
                { name: "Your first lead", company: "Company", stage: "Prospecting" },
                { name: "...", company: "...", stage: "..." },
              ].map((row, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5 text-xs">
                  <div className="flex items-center gap-3">
                    <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium text-muted-foreground">
                      {row.name[0]}
                    </div>
                    <div>
                      <p className={cn("font-medium", i === 0 ? "text-foreground" : "text-muted-foreground/40")}>{row.name}</p>
                      <p className="text-muted-foreground/60">{row.company}</p>
                    </div>
                  </div>
                  <span className={cn(
                    "text-[10px] px-2 py-0.5 rounded-full",
                    i === 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground/40"
                  )}>
                    {row.stage}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-2 max-w-sm mx-auto">
            <Button type="button" variant="outline" onClick={onBack} disabled={isLoading}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </div>
        </>
      )}

      {mode === "upload" && (
        <div className="max-w-sm mx-auto space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileSelect}
            className="hidden"
          />

          <div
            className={cn(
              "border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all",
              parsedLeads.length > 0 ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            {parsedLeads.length > 0 ? (
              <div className="flex flex-col items-center gap-2">
                <FileSpreadsheet className="h-10 w-10 text-primary" />
                <p className="text-sm font-medium text-foreground">{fileName}</p>
                <p className="text-xs text-muted-foreground">
                  {parsedLeads.length} leads found — click to change file
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">Click to select a file</p>
                <p className="text-xs text-muted-foreground">CSV files</p>
              </div>
            )}
          </div>

          {parsedLeads.length > 0 && (
            <div className="max-h-32 overflow-y-auto border border-border rounded-xl divide-y divide-border">
              {parsedLeads.slice(0, 5).map((lead, i) => (
                <div key={i} className="p-2.5 text-sm">
                  <p className="font-medium text-foreground text-xs">{lead.name}</p>
                  <p className="text-muted-foreground text-[11px]">
                    {lead.company} • {lead.email}
                  </p>
                </div>
              ))}
              {parsedLeads.length > 5 && (
                <div className="p-2 text-xs text-muted-foreground text-center">
                  ...and {parsedLeads.length - 5} more
                </div>
              )}
            </div>
          )}

          <div className="bg-muted/30 rounded-xl border border-border p-3 text-xs text-muted-foreground">
            <p className="font-medium mb-1">Expected columns:</p>
            <p>First Name, Last Name, Company, Email, Job Title, Phone, Industry, Country</p>
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={() => { setMode("choose"); setParsedLeads([]); setFileName(null); }} disabled={isLoading}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button
              className="flex-1"
              onClick={handleFileImport}
              disabled={isLoading || parsedLeads.length === 0}
            >
              {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Import {parsedLeads.length} Lead{parsedLeads.length !== 1 ? "s" : ""} & Continue
            </Button>
          </div>
        </div>
      )}

      {mode === "manual" && (
        <form onSubmit={handleManualSubmit} className="space-y-4 max-w-sm mx-auto">
          <div className="space-y-2">
            <Label htmlFor="name">Contact Name</Label>
            <Input id="name" placeholder="John Smith" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} disabled={isLoading} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="company">Company</Label>
            <Input id="company" placeholder="Acme Corp" value={formData.company} onChange={(e) => setFormData({ ...formData, company: e.target.value })} disabled={isLoading} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="john@acme.com" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} disabled={isLoading} />
          </div>
          <div className="space-y-3">
            <Label>Motion</Label>
            <RadioGroup value={formData.motion} onValueChange={(value) => setFormData({ ...formData, motion: value })} disabled={isLoading} className="grid grid-cols-3 gap-3">
              {[
                { value: "outbound_prospecting", id: "outbound", label: "Outbound", desc: "Cold outreach" },
                { value: "inbound_response", id: "inbound", label: "Inbound", desc: "They reached out" },
                { value: "nurture", id: "nurture", label: "Nurture", desc: "Long-term play" },
              ].map((opt) => (
                <div key={opt.value} className="flex flex-col items-center space-y-1.5 p-3 rounded-xl border border-border bg-card hover:bg-accent/30 cursor-pointer text-center">
                  <RadioGroupItem value={opt.value} id={opt.id} />
                  <label htmlFor={opt.id} className="cursor-pointer">
                    <p className="font-medium text-foreground text-sm">{opt.label}</p>
                    <p className="text-xs text-muted-foreground">{opt.desc}</p>
                  </label>
                </div>
              ))}
            </RadioGroup>
          </div>
          <div className="flex gap-3 pt-4">
            <Button type="button" variant="outline" onClick={() => setMode("choose")} disabled={isLoading}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button type="submit" className="flex-1" disabled={isLoading}>
              {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Lead & Continue
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
