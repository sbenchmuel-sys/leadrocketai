// ============================================================================
// Log a meeting — the single dialog for manually recording a meeting that
// happened (usually off-app). Extracted from MeetingsTab so the Meetings tab AND
// the Lead Detail "Latest Meeting" card open the SAME form. The submit logic is a
// VERBATIM move of MeetingsTab's handleAddMeetingSummary (same post_meeting_recap
// + extract_milestones_risks AI calls, same createMeetingPack, same stage update)
// — only the post-save refresh changed (now onSaved() instead of loadData()).
// ============================================================================

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Sparkles } from "lucide-react";
import { useAITask } from "@/hooks/useAITask";
import { supabase } from "@/integrations/supabase/client";
import { createMeetingPack, getLeadDetail, getKnowledgeChunks } from "@/lib/supabaseQueries";
import { extractJson, parseRecapJson } from "@/lib/meetingRecap";

interface LogMeetingDialogProps {
  leadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a meeting is successfully logged so the opener can refresh. */
  onSaved?: () => void;
}

export default function LogMeetingDialog({ leadId, open, onOpenChange, onSaved }: LogMeetingDialogProps) {
  const [addTitle, setAddTitle] = useState("");
  const [addDate, setAddDate] = useState(new Date().toISOString().split("T")[0]);
  const [addNotes, setAddNotes] = useState("");
  const [isAddingMeeting, setIsAddingMeeting] = useState(false);
  const { runTask } = useAITask();

  // VERBATIM move of MeetingsTab.handleAddMeetingSummary — keep behaviour identical
  // (the milestone extraction especially). Only the post-save hook changed.
  const handleSave = async () => {
    if (!addNotes.trim()) {
      toast.error("Please enter meeting notes");
      return;
    }
    setIsAddingMeeting(true);
    try {
      const lead = await getLeadDetail(leadId);
      const leadContext = `Name: ${lead.name}\nCompany: ${lead.company}\nEmail: ${lead.email}\nStrategy: ${lead.strategy}\nStatus: ${lead.status}`;
      const kb = await getKnowledgeChunks(true);
      const knowledgeContext = kb.slice(0, 5).map(k => k.content.slice(0, 500)).join("\n---\n");
      const cleanedNotes = addNotes.split(/\n-{2,}|\nOn .* wrote:|\nFrom:|\n>|\nSent from/)[0].slice(0, 3000).trim();

      // Step 1: Generate recap
      toast.info("Step 1/2: Generating meeting recap...");
      const recapResult = await runTask("post_meeting_recap", {
        mode: lead.strategy,
        lead_context: leadContext,
        meeting_summary: cleanedNotes,
        knowledge_context: knowledgeContext,
        meeting_link: lead.meeting_link || "",
      });

      if (!recapResult.ok || !recapResult.content) {
        throw new Error(recapResult.error || "AI returned an empty recap — please try again");
      }
      const recapData = parseRecapJson(recapResult.content);
      if (!recapData) {
        throw new Error("AI returned an invalid recap format — please try again");
      }

      // Step 2: Extract milestones
      toast.info("Step 2/2: Extracting milestones...");
      const milestonesResult = await runTask("extract_milestones_risks", {
        lead_context: leadContext,
        interactions_text: cleanedNotes,
      });

      let milestonesData: { milestones: Array<{ description: string; status?: string; date?: string }>; risks: unknown[] } = { milestones: [], risks: [] };
      if (milestonesResult.ok && milestonesResult.content) {
        try { milestonesData = JSON.parse(extractJson(milestonesResult.content)); } catch (e) { console.error("Failed to parse milestones:", e); }
      }

      // Create meeting pack
      await createMeetingPack({
        lead_id: leadId,
        title: addTitle.trim() || `Meeting — ${format(parseISO(addDate), "MMM d, yyyy")}`,
        meeting_date: addDate,
        raw_notes: addNotes,
        internal_recap_bullets: (recapData?.internal_recap_bullets as string[]) || [],
        open_questions: (recapData?.open_questions as string[]) || [],
        milestones: (milestonesData.milestones || []).map(m => ({
          description: m.description,
          status: (m.status || "pending") as "completed" | "pending",
          date: m.date || null,
        })),
        follow_up_email_subject: (recapData?.customer_email as Record<string, string>)?.subject || null,
        follow_up_email_body: (recapData?.customer_email as Record<string, string>)?.body || null,
      });

      // Update lead stage to post_meeting
      await supabase.from("leads").update({ stage: "post_meeting", last_activity_at: new Date().toISOString() }).eq("id", leadId);

      toast.success("Meeting summary added with AI analysis!");
      onOpenChange(false);
      setAddTitle("");
      setAddDate(new Date().toISOString().split("T")[0]);
      setAddNotes("");
      onSaved?.();
    } catch (err) {
      console.error("Failed to add meeting summary:", err);
      toast.error(err instanceof Error ? err.message : "Failed to add meeting summary");
    } finally {
      setIsAddingMeeting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isAddingMeeting) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Log a meeting</DialogTitle>
          <DialogDescription>
            Record a meeting that already happened — DrivePilot writes the recap, milestones, and a follow-up email for you.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Title (optional)</label>
              <Input value={addTitle} onChange={e => setAddTitle(e.target.value)} placeholder="e.g. Discovery Call" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Date</label>
              <Input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Meeting Notes</label>
            <Textarea value={addNotes} onChange={e => setAddNotes(e.target.value)} placeholder="Paste meeting notes, key discussion points, and action items..." rows={8} />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={isAddingMeeting || !addNotes.trim()}>
              {isAddingMeeting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
              {isAddingMeeting ? "Analyzing..." : "Log meeting"}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isAddingMeeting}>Cancel</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
