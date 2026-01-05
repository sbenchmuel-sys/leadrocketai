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

  const runMeetingPipeline = async (meetingNotes: string) => {
    setIsRunningPipeline(true);
    try {
      const leadContext = await buildLeadContext();
      const kb = await getKnowledgeChunks(true);
      const knowledgeContext = kb.map((k) => k.content).join("\n---\n");
      const lead = await getLeadDetail(leadId);

      // Step 1: Post meeting recap
      toast.info("Step 1/4: Generating meeting recap...");
      const recapResult = await runTask("post_meeting_recap", {
        mode: lead.strategy,
        lead_context: leadContext,
        meeting_summary: meetingNotes,
        knowledge_context: knowledgeContext,
        meeting_link: lead.meeting_link || "",
      });

      let recapData = null;
      if (recapResult.ok && recapResult.content) {
        try {
          recapData = JSON.parse(recapResult.content);
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

      // Step 2: Extract milestones and risks
      toast.info("Step 2/4: Extracting milestones and risks...");
      const milestonesResult = await runTask("extract_milestones_risks", {
        lead_context: leadContext,
        interactions_text: meetingNotes,
      });

      let milestonesData = { milestones: [], risks: [] };
      if (milestonesResult.ok && milestonesResult.content) {
        try {
          milestonesData = JSON.parse(milestonesResult.content);
        } catch (e) {
          console.error("Failed to parse milestones/risks:", e);
        }
      }

      // Step 3: Extract deal factors
      toast.info("Step 3/4: Analyzing deal factors...");
      const factorsResult = await runTask("extract_deal_factors", {
        lead_context: leadContext,
        interactions_text: meetingNotes,
      });

      let factorsData = null;
      if (factorsResult.ok && factorsResult.content) {
        try {
          factorsData = JSON.parse(factorsResult.content);
        } catch (e) {
          console.error("Failed to parse deal factors:", e);
        }
      }

      // Step 4: Recommend next steps
      toast.info("Step 4/4: Generating recommendations...");
      const recsResult = await runTask("recommend_next_steps", {
        lead_context: leadContext,
        milestones_risks_json: JSON.stringify(milestonesData),
        deal_factors_json: JSON.stringify(factorsData),
      });

      let recsData = { recommendations: [], best_next_step: null };
      if (recsResult.ok && recsResult.content) {
        try {
          recsData = JSON.parse(recsResult.content);
        } catch (e) {
          console.error("Failed to parse recommendations:", e);
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
            // Update the interaction with AI analysis
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