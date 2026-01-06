import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Upload, FileSpreadsheet, Check, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import * as XLSX from "xlsx";

interface ParsedLead {
  name: string;
  company: string;
  email: string;
  strategy: "fast" | "nurture";
  job_title?: string;
  phone?: string;
  industry?: string;
  country?: string;
  initial_message?: string;
}

interface LeadImportDialogProps {
  onImportComplete: () => void;
}

export function LeadImportDialog({ onImportComplete }: LeadImportDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parsedLeads, setParsedLeads] = useState<ParsedLead[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        // Map common column name variations
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
          strategy: "fast" as const,
          job_title: String(row["Job Title"] || row["Title"] || row["job_title"] || "").trim() || undefined,
          phone: String(row["Phone Number"] || row["Phone"] || row["phone"] || "").trim() || undefined,
          industry: String(row["Industry"] || row["industry"] || "").trim() || undefined,
          country: String(row["Country/Region"] || row["Country"] || row["country"] || "").trim() || undefined,
          initial_message: String(row["Message"] || row["Notes"] || row["message"] || "").trim() || undefined,
        };
      });

      // Filter out rows without valid email
      const validLeads = leads.filter(
        (lead) => lead.email && lead.email.includes("@") && !lead.email.includes("unknown.com")
      );

      setParsedLeads(validLeads);

      if (validLeads.length === 0) {
        toast.error("No valid leads found in file. Make sure there's an Email column.");
      } else {
        toast.success(`Found ${validLeads.length} leads to import`);
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

      // Prepare leads with owner_user_id
      const leadsToInsert = parsedLeads.map((lead) => ({
        ...lead,
        owner_user_id: user.id,
        last_activity_at: new Date().toISOString(),
      }));

      const { data, error } = await supabase
        .from("leads")
        .insert(leadsToInsert)
        .select("id");

      if (error) throw error;

      toast.success(`Successfully imported ${data.length} leads!`);
      setIsOpen(false);
      setParsedLeads([]);
      setFileName(null);
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
          <DialogTitle>Import Leads from CSV/Excel</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* File upload area */}
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

          {/* Preview of parsed leads */}
          {parsedLeads.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <Check className="h-4 w-4" />
                <span>{parsedLeads.length} leads ready to import</span>
              </div>

              <div className="max-h-48 overflow-y-auto border border-border rounded-md divide-y divide-border">
                {parsedLeads.slice(0, 5).map((lead, i) => (
                  <div key={i} className="p-3 text-sm">
                    <p className="font-medium text-foreground">{lead.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {lead.company} • {lead.email}
                    </p>
                    {lead.job_title && (
                      <p className="text-muted-foreground text-xs">{lead.job_title}</p>
                    )}
                  </div>
                ))}
                {parsedLeads.length > 5 && (
                  <div className="p-3 text-xs text-muted-foreground text-center">
                    ...and {parsedLeads.length - 5} more
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Expected columns info */}
          <div className="bg-muted/50 rounded-md p-3 text-xs text-muted-foreground">
            <p className="font-medium mb-1">Expected columns:</p>
            <p>First Name, Last Name, Company Name, Email, Job Title, Phone Number, Industry, Country/Region, Message</p>
          </div>

          <Button
            onClick={handleImport}
            disabled={parsedLeads.length === 0 || isImporting}
            className="w-full"
          >
            {isImporting ? "Importing..." : `Import ${parsedLeads.length} Leads`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
