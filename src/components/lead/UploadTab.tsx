import { useState } from "react";
import { insertInteraction, getLeadDetail, getKnowledgeChunks } from "@/lib/supabaseQueries";
import { useAITask } from "@/hooks/useAITask";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Upload, Brain } from "lucide-react";

interface UploadTabProps {
  leadId: string;
  onSuccess: () => void;
}

type InteractionType = "email_inbound" | "email_outbound" | "meeting" | "call" | "note";

export default function UploadTab({ leadId, onSuccess }: UploadTabProps) {
  const [type, setType] = useState<InteractionType>("email_inbound");
  const [subject, setSubject] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRunningPipeline, setIsRunningPipeline] = useState(false);
  const { runTask, isLoading: isAnalyzing } = useAITask();

  const isEmailType = type === "email_inbound" || type === "email_outbound";
  const isMeetingType = type === "meeting";

  const buildLeadContext = async () => {
    const lead = await getLeadDetail(leadId);
    return `Name: ${lead.name}
Company: ${lead.company}
Email: ${lead.email}
Strategy: ${lead.strategy}
Status: ${lead.status}
${lead.personal_notes ? `Notes: ${lead.personal_notes}` : ""}`;
  };

  // Helper to extract JSON from AI response (may be wrapped in markdown fences)
  const extractJson = (content: string): string => {
    const trimmed = content.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    return (fenced?.[1] ?? trimmed).trim();
  };

  // Helper to clean and limit text for AI payloads
  const cleanTextForPayload = (text: string, maxChars: number = 2000): string => {
    return text
      .split(/\n-{2,}|\nOn .* wrote:|\nFrom:|\n>|\nSent from/)[0] // Remove quoted text
      .slice(0, maxChars)
      .trim();
  };

  const runMeetingPipeline = async (meetingNotes: string) => {
    setIsRunningPipeline(true);
    try {
      const leadContext = await buildLeadContext();
      const kb = await getKnowledgeChunks(true);
      // Limit knowledge context to first 5 chunks, 500 chars each
      const knowledgeContext = kb
        .slice(0, 5)
        .map((k) => k.content.slice(0, 500))
        .join("\n---\n");
      const lead = await getLeadDetail(leadId);
      
      // Clean meeting notes to reduce payload size
      const cleanedMeetingNotes = cleanTextForPayload(meetingNotes, 3000);
      console.log("[Meeting Pipeline] Meeting notes size:", cleanedMeetingNotes.length, "chars");
      console.log("[Meeting Pipeline] Knowledge context size:", knowledgeContext.length, "chars");

      // Step 1: Post meeting recap
      toast.info("Step 1/4: Generating meeting recap...");
      const recapResult = await runTask("post_meeting_recap", {
        mode: lead.strategy,
        lead_context: leadContext,
        meeting_summary: cleanedMeetingNotes,
        knowledge_context: knowledgeContext,
        meeting_link: lead.meeting_link || "",
      });

      let recapData = null;
      if (recapResult.ok && recapResult.content) {
        try {
          recapData = JSON.parse(extractJson(recapResult.content));
          // Save the customer email as a draft
          if (recapData.customer_email) {
            await supabase.from("drafts").insert({
              lead_id: leadId,
              channel: "email",
              draft_type: "post_meeting_followup",
              subject: recapData.customer_email.subject,
              body_text: recapData.customer_email.body,
              to_recipient: lead.email,
            });
          }
        } catch (e) {
          console.error("Failed to parse recap result:", e);
        }
      }

      // Step 2: Deep analysis (milestones, deal factors, recommendations in one call)
      toast.info("Step 2/2: Running deep analysis...");
      const deepResult = await runTask("lead_deep_analysis", {
        lead_context: leadContext,
        interactions_text: cleanedMeetingNotes,
      });

      let milestonesData = { milestones: [], risks: [] };
      let factorsData = null;
      let recsData = { recommendations: [], best_next_step: null };
      if (deepResult.ok && deepResult.content) {
        try {
          const parsed = JSON.parse(extractJson(deepResult.content));
          milestonesData = { milestones: parsed.milestones || [], risks: parsed.risks || [] };
          factorsData = parsed.deal_factors || null;
          recsData = { recommendations: parsed.recommendations || [], best_next_step: parsed.best_next_step || null };
        } catch (e) {
          console.error("Failed to parse deep analysis:", e);
        }
      }

      // Update the lead with all extracted data
      const { error: updateError } = await supabase
        .from("leads")
        .update({
          milestones_json: milestonesData.milestones,
          risks_json: milestonesData.risks,
          deal_factors_json: factorsData,
          next_step: recsData.best_next_step?.title || null,
          next_step_reason: recsData.best_next_step?.why || null,
          deal_outlook: factorsData?.overall_outlook || null,
          last_ai_run_at: new Date().toISOString(),
          last_activity_at: new Date().toISOString(),
        })
        .eq("id", leadId);

      if (updateError) {
        console.error("Failed to update lead:", updateError);
        toast.error("Failed to save analysis to lead");
      } else {
        toast.success("Meeting analysis complete! Check Recommendations tab for insights.");
      }
    } catch (err) {
      console.error("Pipeline error:", err);
      toast.error("Analysis pipeline failed");
    } finally {
      setIsRunningPipeline(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bodyText.trim()) {
      toast.error("Please enter content");
      return;
    }

    setIsSubmitting(true);

    try {
      // Insert the interaction
      await insertInteraction(leadId, {
        type,
        subject: subject || undefined,
        from_email: fromEmail || undefined,
        to_email: toEmail || undefined,
        body_text: bodyText,
      });

      // Auto-update lead state based on interaction type
      const now = new Date().toISOString();
      if (type === "email_inbound") {
        // Update timestamps and elevate stage to at least 'engaged'
        const { data: currentLead } = await supabase
          .from("leads")
          .select("stage, last_inbound_at, motion")
          .eq("id", leadId)
          .single();

        const stageHierarchy: Record<string, number> = {
          new: 0, contacted: 1, engaged: 2, post_meeting: 3, closing: 4, closed: 5,
        };
        const currentStageRank = stageHierarchy[currentLead?.stage || "new"] ?? 0;
        const newStage = currentStageRank < 2 ? "engaged" : currentLead?.stage;

        await supabase
          .from("leads")
          .update({
            last_inbound_at: now,
            stage: newStage,
            last_activity_at: now,
          })
          .eq("id", leadId);
      } else if (type === "email_outbound") {
        // Update outbound timestamps
        const { data: currentLead } = await supabase
          .from("leads")
          .select("first_outbound_at, stage")
          .eq("id", leadId)
          .single();

        const stageHierarchy: Record<string, number> = {
          new: 0, contacted: 1, engaged: 2, post_meeting: 3, closing: 4, closed: 5,
        };
        const currentStageRank = stageHierarchy[currentLead?.stage || "new"] ?? 0;
        const newStage = currentStageRank < 1 ? "contacted" : currentLead?.stage;

        await supabase
          .from("leads")
          .update({
            last_outbound_at: now,
            first_outbound_at: currentLead?.first_outbound_at || now,
            stage: newStage,
            last_activity_at: now,
          })
          .eq("id", leadId);
      } else if (type === "meeting") {
        // Update stage to post_meeting
        await supabase
          .from("leads")
          .update({
            stage: "post_meeting",
            last_activity_at: now,
          })
          .eq("id", leadId);
      }

      // If inbound email, run intent router
      if (type === "email_inbound") {
        toast.info("Analyzing email...");
        const leadContext = await buildLeadContext();
        const result = await runTask("intent_router", {
          lead_context: leadContext,
          email_text: bodyText,
        });

        if (result.ok && result.content) {
          try {
            const parsed = JSON.parse(result.content);
            // TODO(cleanup): AI annotation columns (ai_intent/ai_summary/ai_reply_worthy)
            // currently live only on `interactions`. When these are migrated onto
            // `lead_timeline_items.metadata_json`, route this update through a shared
            // helper. For now this enriches the row that `insertInteraction` just
            // wrote (and projected to the timeline) above.
            const { data: interactions } = await supabase
              .from("interactions")
              .select("id")
              .eq("lead_id", leadId)
              .order("occurred_at", { ascending: false })
              .limit(1);

            if (interactions && interactions[0]) {
              await supabase
                .from("interactions")
                .update({
                  ai_intent: parsed.intent_primary,
                  ai_summary: `${parsed.tone} tone, ${parsed.urgency} urgency. Strategy: ${parsed.suggested_strategy}`,
                  ai_reply_worthy: parsed.reply_worthy,
                })
                .eq("id", interactions[0].id);
            }
            toast.success(`Email analyzed: ${parsed.intent_primary}, ${parsed.reply_worthy ? "reply needed" : "no reply needed"}`);
          } catch {
            console.error("Failed to parse intent router response");
          }
        }
      } else if (type === "meeting") {
        // For meeting summaries, run the full AI pipeline
        toast.success("Meeting notes added. Starting AI analysis pipeline...");
        await runMeetingPipeline(bodyText);
      } else {
        toast.success("Interaction added");
      }

      // Reset form
      setSubject("");
      setFromEmail("");
      setToEmail("");
      setBodyText("");
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add interaction");
    } finally {
      setIsSubmitting(false);
    }
  };

  const isProcessing = isSubmitting || isAnalyzing || isRunningPipeline;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Interaction</CardTitle>
        <CardDescription>
          Upload an email, meeting notes, or call summary. Inbound emails are analyzed for intent. Meeting notes trigger a full AI analysis pipeline.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as InteractionType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email_inbound">Inbound Email</SelectItem>
                <SelectItem value="email_outbound">Outbound Email</SelectItem>
                <SelectItem value="meeting">Meeting Notes</SelectItem>
                <SelectItem value="call">Call Notes</SelectItem>
                <SelectItem value="note">Internal Note</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isEmailType && (
            <>
              <div className="space-y-2">
                <Label>Subject</Label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Email subject"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>From</Label>
                  <Input
                    type="email"
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    placeholder="sender@example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label>To</Label>
                  <Input
                    type="email"
                    value={toEmail}
                    onChange={(e) => setToEmail(e.target.value)}
                    placeholder="recipient@example.com"
                  />
                </div>
              </div>
            </>
          )}

          {isMeetingType && (
            <div className="p-3 bg-primary/10 rounded-lg flex items-start gap-2">
              <Brain className="h-5 w-5 text-primary mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-primary">AI Analysis Pipeline</p>
                <p className="text-muted-foreground">
                  Meeting notes will automatically trigger: recap generation → milestone extraction → deal factor analysis → next step recommendations
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Content</Label>
            <Textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              placeholder={isMeetingType ? "Paste meeting notes, key discussion points, and action items..." : isEmailType ? "Paste email content here..." : "Enter notes..."}
              rows={8}
              required
            />
          </div>

          <Button type="submit" disabled={isProcessing}>
            {isProcessing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-2" />
            )}
            {isRunningPipeline ? "Running AI Pipeline..." : isAnalyzing ? "Analyzing..." : isSubmitting ? "Saving..." : isMeetingType ? "Add & Analyze Meeting" : "Add Interaction"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}