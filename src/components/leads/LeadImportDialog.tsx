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
import { parseLeadFile, extractLeadContextItems, type ParsedLead } from "@/lib/parseLeadFile";
import { summarizeEmailQuality } from "@/lib/emailValidation";
import { useWorkspace } from "@/contexts/WorkspaceContext";

type ImportStep = "upload" | "source" | "confirm";

const SOURCE_OPTIONS = [
  { key: "outbound", emoji: "🔵", label: "Outbound prospect list", description: "Cold outreach, prospecting lists" },
  { key: "reactivation", emoji: "🔄", label: "Reactivation / historical list", description: "Re-engaging old leads or leads from a previous owner" },
  { key: "inbound_website", emoji: "🟢", label: "Website contact form", description: "Leads from your website or landing pages" },
  { key: "event", emoji: "🟣", label: "Event / conference", description: "Leads collected at trade shows or events" },
  { key: "referral", emoji: "🟡", label: "Referral", description: "Warm introductions from partners or customers" },
  { key: "other", emoji: "⚪", label: "Other", description: "Manual entry or miscellaneous sources" },
] as const;

interface LeadImportDialogProps {
  onImportComplete: () => void;
}

export function LeadImportDialog({ onImportComplete }: LeadImportDialogProps) {
  const { workspaceId } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parsedLeads, setParsedLeads] = useState<ParsedLead[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [step, setStep] = useState<ImportStep>("upload");
  const [selectedSource, setSelectedSource] = useState<string>("outbound");
  const [autoSendIntro, setAutoSendIntro] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const preset = SOURCE_PRESETS[selectedSource] || SOURCE_PRESETS.outbound;
  const isOutbound = preset.origin === "outbound" && selectedSource !== "reactivation";

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    try {
      const validLeads = await parseLeadFile(file);
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
    if (!workspaceId) {
      toast.error("No active workspace selected. Please select a workspace first.");
      return;
    }

    setIsImporting(true);

    try {
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (authErr || !user) throw new Error("Not logged in");

      const validStages = ["new", "contacted", "engaged", "post_meeting", "closing", "closed_won", "closed_lost"];
      const isReactivation = selectedSource === "reactivation";
      const reactivationMotion = preset.motion; // "re_engagement" for reactivation

      // ---- Deduplication ----
      // 1) Within-file: collapse rows sharing the same email (case-insensitive).
      // 2) Against workspace: skip emails that already exist on a lead in this workspace.
      const seenEmails = new Set<string>();
      const dedupedInFile: ParsedLead[] = [];
      let inFileDupes = 0;
      for (const lead of parsedLeads) {
        const e = (lead.email || "").trim().toLowerCase();
        if (!e) {
          // Keep emailless rows (rare) — they can't collide on email
          dedupedInFile.push(lead);
          continue;
        }
        if (seenEmails.has(e)) { inFileDupes++; continue; }
        seenEmails.add(e);
        dedupedInFile.push(lead);
      }

      const emailList = Array.from(seenEmails);
      let existingEmails = new Set<string>();
      if (emailList.length > 0) {
        // Chunk to stay under URL limits on .in() filters
        const chunkSize = 200;
        for (let i = 0; i < emailList.length; i += chunkSize) {
          const chunk = emailList.slice(i, i + chunkSize);
          const { data: existing, error: existErr } = await supabase
            .from("leads")
            .select("email")
            .eq("workspace_id", workspaceId)
            .in("email", chunk);
          if (existErr) {
            console.error("Dedup lookup failed (continuing without workspace dedup):", existErr);
            break;
          }
          for (const row of existing || []) {
            if (row.email) existingEmails.add(row.email.toLowerCase());
          }
        }
      }

      const finalParsedLeads = dedupedInFile.filter((lead) => {
        const e = (lead.email || "").trim().toLowerCase();
        return !e || !existingEmails.has(e);
      });
      const workspaceDupes = dedupedInFile.length - finalParsedLeads.length;

      if (finalParsedLeads.length === 0) {
        toast.error(`All ${parsedLeads.length} leads already exist in this workspace — nothing to import.`);
        setIsImporting(false);
        return;
      }

      const leadsToInsert = finalParsedLeads.map((lead) => {
        // Item 4: Build personal_notes from supplementary import fields
        const noteParts: string[] = [];
        if (lead.history_notes) noteParts.push(`History: ${lead.history_notes}`);
        if (lead.owner_name) noteParts.push(`Previous owner: ${lead.owner_name}`);
        if (lead.previous_owner && lead.previous_owner !== lead.owner_name) noteParts.push(`Previous owner: ${lead.previous_owner}`);
        if (lead.priority_label) noteParts.push(`Priority: ${lead.priority_label}`);
        if (lead.source_label) noteParts.push(`Source: ${lead.source_label}`);
        if (lead.product) noteParts.push(`Product: ${lead.product}`);
        if (lead.last_contact_date) noteParts.push(`Last contact: ${lead.last_contact_date}`);
        const personalNotes = noteParts.length > 0 ? noteParts.join(" | ") : undefined;

        // Validate stage if provided
        const importedStage = lead.stage?.toLowerCase().replace(/[\s-]+/g, "_");
        const resolvedStage = importedStage && validStages.includes(importedStage) ? importedStage : undefined;

        // Item 3: Reactivation leads default to "contacted" stage
        const finalStage = resolvedStage || (isReactivation ? "contacted" : undefined);

        // Strip extended fields before spread (they don't exist on leads table)
        const {
          stage: _s,
          priority_label: _p,
          source_label: _sl,
          product: _pr,
          owner_name: _o,
          previous_owner: _po,
          last_contact_date: _lc,
          next_step_text: _ns,
          history_notes: _h,
          raw_import_json: _raw,
          caution: _ca,
          competitor: _co,
          objection: _ob,
          pain_point: _pp,
          referral_source: _rs,
          deal_value: _dv,
          next_milestone_date: _nmd,
          ...leadFields
        } = lead;

        // Client-generated UUID — guarantees we know each lead's ID before insert
        const leadId = crypto.randomUUID();

        return {
          id: leadId,
          ...leadFields,
          owner_user_id: user.id,
          workspace_id: workspaceId,
          source_type: preset.source_type,
          motion: preset.motion,
          strategy: 'fast' as const,
          last_activity_at: new Date().toISOString(),
          ...(personalNotes && { personal_notes: personalNotes }),
          ...(finalStage && { stage: finalStage }),
          ...(lead.next_step_text && { next_step: lead.next_step_text }),
          // Preserve raw import data verbatim
          ...(lead.raw_import_json && { raw_import_json: lead.raw_import_json }),
        };
      });

      const { data, error } = await supabase
        .from("leads")
        .insert(leadsToInsert)
        .select("id");

      if (error) throw error;

      const count = data.length;

      // Phase 1B: Extract and insert lead context items (non-blocking)
      // Uses client-generated UUIDs — each lead's ID is known before insert
      if (leadsToInsert.length > 0) {
        try {
          const allContextItems = leadsToInsert.flatMap((insertedLead, idx) => {
            const parsedLead = finalParsedLeads[idx];
            if (!parsedLead) return [];
            return extractLeadContextItems(parsedLead, insertedLead.id, workspaceId);
          });

          if (allContextItems.length > 0) {
            const { error: ctxErr } = await supabase
              .from("lead_context_items")
              .insert(allContextItems);
            if (ctxErr) {
              console.error("Failed to insert lead context items:", ctxErr);
            } else {
              console.log(`[import] Inserted ${allContextItems.length} lead context items for ${count} leads`);
            }
          }
        } catch (ctxErr) {
          console.error("Lead context extraction failed (non-fatal):", ctxErr);
        }
      }

      const skipped = inFileDupes + workspaceDupes;
      const skipNote = skipped > 0
        ? ` (skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}${workspaceDupes > 0 ? ` — ${workspaceDupes} already in workspace` : ""})`
        : "";

      if (autoSendIntro && isOutbound) {
        toast.success(`Imported ${count} leads${skipNote} — intro emails will be queued`, {
          description: "Drafts will be generated for each lead automatically.",
        });
      } else {
        toast.success(`Successfully imported ${count} leads${skipNote}`);
      }

      handleClose(false);
      onImportComplete();
    } catch (err: any) {
      const detail = err?.message || err?.details || err?.hint || JSON.stringify(err);
      console.error("Import failed:", detail, err);
      toast.error(detail || "Failed to import leads");
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
          Import Leads
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "upload" && "Import Leads from CSV or Excel"}
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
                  accept=".csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
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
                      CSV or Excel files
                    </p>
                  </>
                )}
              </div>

              <div className="bg-muted/50 rounded-md p-3 text-xs text-muted-foreground">
                <p className="font-medium mb-1">Expected columns:</p>
                <p>First Name, Last Name, Company Name, Email, Job Title, Phone Number, Industry, Country/Region, Website, LinkedIn URL, City, State, Message</p>
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
                {autoSendIntro && isOutbound && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Auto-intro</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                      ✓ Enabled
                    </span>
                  </div>
                )}
              </div>

              {/* Email-quality heads-up (cold-send safety) */}
              {(() => {
                const q = summarizeEmailQuality(parsedLeads.map((l) => l.email));
                if (!q.invalid && !q.suspicious) return null;
                return (
                  <div className="rounded-lg border border-amber-300/50 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/10 dark:text-amber-300">
                    {q.invalid > 0 && (
                      <p>{q.invalid} address{q.invalid === 1 ? "" : "es"} look invalid — they won't be emailed.</p>
                    )}
                    {q.suspicious > 0 && (
                      <p>{q.suspicious} look risky (test/role/throwaway) — double-check before adding to an outreach.</p>
                    )}
                  </div>
                );
              })()}

              {/* Lead preview */}
              <div className="max-h-36 overflow-y-auto border border-border rounded-md divide-y divide-border">
                {parsedLeads.slice(0, 5).map((lead, i) => (
                  <div key={i} className="p-2.5 text-sm">
                    <p className="font-medium text-foreground text-xs">{lead.name}</p>
                    <p className="text-muted-foreground text-[11px]">
                      {lead.company} • {lead.email}
                      {lead.city || lead.state ? ` • ${[lead.city, lead.state].filter(Boolean).join(", ")}` : ""}
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
