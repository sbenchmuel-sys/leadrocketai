import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Upload, FileSpreadsheet, Check, Send, ArrowRight, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { SOURCE_PRESETS, SOURCE_TYPE_COLORS } from "@/lib/dashboardUtils";
import * as XLSX from "xlsx";

interface ParsedLead {
  name: string;
  company: string;
  email: string;
  job_title?: string;
  phone?: string;
  industry?: string;
  country?: string;
  initial_message?: string;
}

type ImportStep = "upload" | "source" | "confirm";

const SOURCE_OPTIONS = [
  { key: "outbound", emoji: "🔵", label: "Outbound prospect list", description: "Cold outreach, prospecting lists" },
  { key: "inbound_website", emoji: "🟢", label: "Website contact form", description: "Leads from your website or landing pages" },
  { key: "event", emoji: "🟣", label: "Event / conference", description: "Leads collected at trade shows or events" },
  { key: "referral", emoji: "🟡", label: "Referral", description: "Warm introductions from partners or customers" },
  { key: "other", emoji: "⚪", label: "Other", description: "Manual entry or miscellaneous sources" },
] as const;

interface LeadImportDialogProps {
  onImportComplete: () => void;
}

export function LeadImportDialog({ onImportComplete }: LeadImportDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parsedLeads, setParsedLeads] = useState<ParsedLead[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [step, setStep] = useState<ImportStep>("upload");
  const [selectedSource, setSelectedSource] = useState<string>("outbound");
  const [autoSendIntro, setAutoSendIntro] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const preset = SOURCE_PRESETS[selectedSource] || SOURCE_PRESETS.outbound;
  const isOutbound = preset.origin === "outbound";

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet);

      const leads: ParsedLead[] = jsonData.map((row) => {
        const firstName = String(row["First Name"] || row["FirstName"] || row["first_name"] || "").trim();
        const lastName = String(row["Last Name"] || row["LastName"] || row["last_name"] || "").trim();
        const name = firstName && lastName
          ? `${firstName} ${lastName}`
          : String(row["Name"] || row["name"] || firstName || "Unknown").trim();

        const company = String(
          row["Company Name"] || row["Company"] || row["company"] || row["company_name"] || ""
        ).trim();

        const email = String(
          row["Email"] || row["email"] || row["Email Address"] || ""
        ).trim().toLowerCase();

        return {
          name,
          company: company || "Unknown Company",
          email: email || `${name.toLowerCase().replace(/\s+/g, ".")}@unknown.com`,
          job_title: String(row["Job Title"] || row["Title"] || row["job_title"] || "").trim() || undefined,
          phone: String(row["Phone Number"] || row["Phone"] || row["phone"] || "").trim() || undefined,
          industry: String(row["Industry"] || row["industry"] || "").trim() || undefined,
          country: String(row["Country/Region"] || row["Country"] || row["country"] || "").trim() || undefined,
          initial_message: String(row["Message"] || row["Notes"] || row["message"] || "").trim() || undefined,
        };
      });

      const validLeads = leads.filter(
        (lead) => lead.email && lead.email.includes("@") && !lead.email.includes("unknown.com")
      );

      setParsedLeads(validLeads);

      if (validLeads.length === 0) {
        toast.error("No valid leads found in file. Make sure there's an Email column.");
      } else {
        toast.success(`Found ${validLeads.length} leads to import`);
        setStep("source");
      }
    } catch (err) {
      console.error("Failed to parse file:", err);
      toast.error("Failed to parse file. Please check the format.");
      setParsedLeads([]);
    }
  };

  const handleImport = async () => {
    if (parsedLeads.length === 0) return;

    setIsImporting(true);

    try {
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (authErr || !user) throw new Error("Not logged in");

      const leadsToInsert = parsedLeads.map((lead) => ({
        ...lead,
        owner_user_id: user.id,
        source_type: preset.source_type,
        motion: preset.motion,
        strategy: 'fast' as const, // kept for DB compatibility
        last_activity_at: new Date().toISOString(),
      }));

      const { data, error } = await supabase
        .from("leads")
        .insert(leadsToInsert)
        .select("id");

      if (error) throw error;

      const count = data.length;

      if (autoSendIntro && isOutbound) {
        toast.success(`Imported ${count} leads — intro emails will be queued`, {
          description: "Drafts will be generated for each lead automatically.",
        });
      } else {
        toast.success(`Successfully imported ${count} leads!`);
      }

      handleClose(false);
      onImportComplete();
    } catch (err) {
      console.error("Import failed:", err);
      toast.error(err instanceof Error ? err.message : "Failed to import leads");
    } finally {
      setIsImporting(false);
    }
  };

  const handleClose = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setParsedLeads([]);
      setFileName(null);
      setStep("upload");
      setSelectedSource("outbound");
      setAutoSendIntro(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="h-4 w-4 mr-2" />
          Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "upload" && "Import Leads from CSV/Excel"}
            {step === "source" && "How were these leads generated?"}
            {step === "confirm" && "Confirm Import"}
          </DialogTitle>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-2">
          {["upload", "source", "confirm"].map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors",
                step === s
                  ? "bg-primary text-primary-foreground"
                  : ["upload", "source", "confirm"].indexOf(step) > i
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
              )}>
                {i + 1}
              </div>
              {i < 2 && <div className="w-8 h-px bg-border" />}
            </div>
          ))}
        </div>

        <div className="space-y-4">
          {/* STEP 1: Upload */}
          {step === "upload" && (
            <>
              <div
                className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <FileSpreadsheet className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                {fileName ? (
                  <p className="text-sm font-medium text-foreground">{fileName}</p>
                ) : (
                  <>
                    <p className="text-sm font-medium text-foreground">
                      Click to upload or drag and drop
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      CSV, XLS, or XLSX files
                    </p>
                  </>
                )}
              </div>

              <div className="bg-muted/50 rounded-md p-3 text-xs text-muted-foreground">
                <p className="font-medium mb-1">Expected columns:</p>
                <p>First Name, Last Name, Company Name, Email, Job Title, Phone Number, Industry, Country/Region, Message</p>
              </div>
            </>
          )}

          {/* STEP 2: Source Gate */}
          {step === "source" && (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Check className="h-4 w-4 text-green-500" />
                <span>{parsedLeads.length} leads from <strong>{fileName}</strong></span>
              </div>

              <div className="space-y-2">
                {SOURCE_OPTIONS.map((opt) => {
                  const isSelected = selectedSource === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setSelectedSource(opt.key)}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left",
                        isSelected
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border hover:border-primary/30 hover:bg-muted/30"
                      )}
                    >
                      <span className="text-lg">{opt.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <p className={cn(
                          "text-sm font-medium",
                          isSelected ? "text-foreground" : "text-muted-foreground"
                        )}>
                          {opt.label}
                        </p>
                        <p className="text-xs text-muted-foreground">{opt.description}</p>
                      </div>
                      <div className={cn(
                        "w-4 h-4 rounded-full border-2 transition-colors flex items-center justify-center",
                        isSelected ? "border-primary bg-primary" : "border-muted-foreground/30"
                      )}>
                        {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Auto-send toggle for outbound */}
              {isOutbound && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/50">
                  <Checkbox
                    id="auto-send"
                    checked={autoSendIntro}
                    onCheckedChange={(v) => setAutoSendIntro(!!v)}
                  />
                  <Label htmlFor="auto-send" className="flex-1 cursor-pointer">
                    <div className="flex items-center gap-2">
                      <Send className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                      <span className="text-sm font-medium text-blue-800 dark:text-blue-200">
                        Generate intro emails automatically
                      </span>
                    </div>
                    <p className="text-xs text-blue-600/80 dark:text-blue-400/80 mt-0.5">
                      AI-drafted intros will be queued as drafts for your review
                    </p>
                  </Label>
                </div>
              )}

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setStep("upload")}>
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back
                </Button>
                <Button className="flex-1" onClick={() => setStep("confirm")}>
                  Continue
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </>
          )}

          {/* STEP 3: Confirm */}
          {step === "confirm" && (
            <>
              {/* Summary */}
              <div className="rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Leads</span>
                  <span className="font-medium text-foreground">{parsedLeads.length}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Source</span>
                  <span className={cn(
                    "text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1.5",
                    SOURCE_TYPE_COLORS[preset.source_type]?.bg,
                    SOURCE_TYPE_COLORS[preset.source_type]?.text,
                  )}>
                    <span className={cn("w-1.5 h-1.5 rounded-full", SOURCE_TYPE_COLORS[preset.source_type]?.dot)} />
                    {SOURCE_OPTIONS.find(o => o.key === selectedSource)?.label}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Motion</span>
                  <span className="font-medium text-foreground capitalize">{preset.motion.replace(/_/g, ' ')}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Motion</span>
                  <span className="font-medium text-foreground capitalize">{preset.motion.replace(/_/g, ' ')}</span>
                </div>
                {autoSendIntro && isOutbound && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Auto-intro</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                      ✓ Enabled
                    </span>
                  </div>
                )}
              </div>

              {/* Lead preview */}
              <div className="max-h-36 overflow-y-auto border border-border rounded-md divide-y divide-border">
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

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setStep("source")}>
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back
                </Button>
                <Button
                  onClick={handleImport}
                  disabled={isImporting}
                  className="flex-1"
                >
                  {isImporting ? "Importing..." : `Import ${parsedLeads.length} Leads`}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
