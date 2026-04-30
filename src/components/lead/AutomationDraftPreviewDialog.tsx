import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Loader2, CheckCircle2, Wand2 } from "lucide-react";
import { saveDraft } from "@/lib/supabaseQueries";
import { generateDraft as generateDraftPipeline } from "@/lib/generateDraft";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { LeadDetail } from "@/lib/supabaseQueries";

const INBOUND_SOURCE_TYPES = new Set(["contact_form", "gmail_inbound", "referral", "whatsapp_inbound"]);

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadDetail;
  stepKey: string;
  stepLabel: string;
  onSaved: () => void;
}

export default function AutomationDraftPreviewDialog({
  open, onOpenChange, lead, stepKey, stepLabel, onSaved,
}: Props) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(false);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setBody("");
    setSubject("");
    try {
      // Map step key → AI task. Inbound leads stay on the warm cadence for the
      // entire 3-step sequence (inbound_intro → inbound_followup_1 → inbound_followup_2).
      // Cold outbound uses the 4-step cold framework. Must mirror automation-executor.
      const motion = (lead as any).motion || "outbound_prospecting";
      const sourceType = (lead as any).source_type || "manual_entry";
      const isInbound = motion === "inbound_response" || INBOUND_SOURCE_TYPES.has(sourceType);
      let overrideIntent: string;
      if (stepKey.startsWith("send_pre_1")) overrideIntent = isInbound ? "inbound_intro" : "pre_email_1_intro";
      else if (stepKey.startsWith("send_pre_2")) overrideIntent = isInbound ? "inbound_followup_1" : "pre_email_2_followup";
      else if (stepKey.startsWith("send_pre_3")) overrideIntent = isInbound ? "inbound_followup_2" : "pre_email_3_followup";
      else if (stepKey.startsWith("send_pre_4")) overrideIntent = "pre_email_4_breakup";
      else if (stepKey.startsWith("nurture_")) overrideIntent = "nurture_email_single";
      else overrideIntent = isInbound ? "inbound_followup_1" : "pre_email_2_followup";

      const result = await generateDraftPipeline({
        lead_id: lead.id,
        channel: "email",
        override_intent: overrideIntent as any,
        motion_override: isInbound ? "inbound_response" : null,
      });

      if (result.draft_text) {
        const lines = result.draft_text.split("\n");
        const subjectLine = lines.find(l => l.toLowerCase().startsWith("subject:"));
        if (subjectLine) {
          setSubject(subjectLine.replace(/^subject:\s*/i, "").trim());
          setBody(lines.filter(l => !l.toLowerCase().startsWith("subject:")).join("\n").trim());
        } else {
          setBody(result.draft_text);
          setSubject(result.suggested_subject || `Following up - ${lead.name.split(" ")[0]}`);
        }
      }
      setHasGenerated(true);
    } catch (err) {
      console.error("[AutomationDraftPreview] Generation error:", err);
      toast.error("Failed to generate draft");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!body.trim()) return;
    setIsSaving(true);
    try {
      // Delete any existing approved/pending drafts for this step
      await supabase
        .from("drafts")
        .delete()
        .eq("lead_id", lead.id)
        .eq("step_key", stepKey)
        .in("status", ["approved", "pending"]);

      await saveDraft(lead.id, {
        channel: "email",
        draft_type: "automation",
        to_recipient: lead.email,
        subject: subject || undefined,
        body_text: body,
        step_key: stepKey,
        status: "approved",
      });

      toast.success(`Draft saved — automation will send this version for "${stepLabel}"`);
      onOpenChange(false);
      onSaved();
    } catch (err) {
      console.error("[AutomationDraftPreview] Save error:", err);
      toast.error("Failed to save draft");
    } finally {
      setIsSaving(false);
    }
  };

  // Load existing approved draft when dialog opens
  const handleOpenChange = (open: boolean) => {
    if (open) {
      setHasGenerated(false);
      setBody("");
      setSubject("");
      // Check for existing approved draft
      supabase
        .from("drafts")
        .select("body_text, subject")
        .eq("lead_id", lead.id)
        .eq("step_key", stepKey)
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.body_text) {
            setBody(data.body_text);
            setSubject(data.subject || "");
            setHasGenerated(true);
          }
        });
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">
            Preview: {stepLabel}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Generate, edit, and save. The automation will send this exact version when the time comes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!hasGenerated && !isGenerating && (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <p className="text-sm text-muted-foreground">Generate a draft to preview and edit before it sends.</p>
              <Button onClick={handleGenerate} size="sm">
                <Wand2 className="h-3.5 w-3.5 mr-1.5" />
                Generate Draft
              </Button>
            </div>
          )}

          {isGenerating && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground ml-2">Generating draft…</span>
            </div>
          )}

          {hasGenerated && !isGenerating && (
            <>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Subject</label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full text-sm border border-input bg-background rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Email subject..."
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Body</label>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={10}
                  className="text-sm"
                  placeholder="Email body..."
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerate}
                className="text-xs"
              >
                <Wand2 className="h-3 w-3 mr-1" />
                Regenerate
              </Button>
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isGenerating || isSaving || !body.trim()}
          >
            {isSaving ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Saving…</>
            ) : (
              <><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Save for Sending</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
