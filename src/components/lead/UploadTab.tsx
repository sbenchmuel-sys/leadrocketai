import { useState } from "react";
import { insertInteraction, getLeadDetail, getKnowledgeChunks, annotateInteractionAI, saveLeadDeepAnalysis } from "@/lib/supabaseQueries";
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
import { raiseStage, type DealStage } from "@/lib/dashboardUtils";

interface UploadTabProps {
  leadId: string;
  onSuccess: () => void;
}

type InteractionType = "email_inbound" | "email_outbound" | "meeting" | "call" | "note";

// Lowest stage each logged interaction implies. A call may be "no answer", so it
// only proves contact. Notes don't move the stage.
const MIN_STAGE: Partial<Record<InteractionType, DealStage>> = {
  email_inbound: "engaged",
  email_outbound: "contacted",
  meeting: "post_meeting",
  call: "contacted",
};

// DB timestamps ("…+00:00") and toISOString() ("….000Z") differ in format, so compare as dates.
const later = (a: string | null | undefined, b: string) => (a && Date.parse(a) > Date.parse(b) ? a : b);
const earlier = (a: string | null | undefined, b: string) => (a && Date.parse(a) < Date.parse(b) ? a : b);

export default function UploadTab({ leadId, onSuccess }: UploadTabProps) {
  const [type, setType] = useState<InteractionType>("email_inbound");
  const [subject, setSubject] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [occurredAt, setOccurredAt] = useState(""); // datetime-local; empty = now
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRunningPipeline, setIsRunningPipeline] = useState(false);
  const { runTask, isLoading: isAnalyzing } = useAITask();

  const isEmailType = type === "email_inbound" || type === "email_outbound";
  const isMeetingType = type === "meeting";
  // Meetings and calls both get the recap + follow-up draft + deep analysis.
  const isAnalysedType = type === "meeting" || type === "call";

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

  const runRecapAndAnalysis = async (notes: string, kind: "meeting" | "call", interactionId: string) => {
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
      
      // Clean notes to reduce payload size
      const cleanedMeetingNotes = cleanTextForPayload(notes, 3000);

      // Step 1: recap + customer follow-up draft. The post_meeting_recap prompt
      // takes "a meeting summary (or notes)", so call notes reuse it as-is.
      toast.info(`Step 1/2: Generating ${kind} recap and follow-up draft...`);
      const recapResult = await runTask("post_meeting_recap", {
        mode: lead.strategy,
        lead_context: leadContext,
        meeting_summary: kind === "call" ? `Phone call notes:\n${cleanedMeetingNotes}` : cleanedMeetingNotes,
        knowledge_context: knowledgeContext,
        meeting_link: lead.meeting_link || "",
      });

      let recapData = null;
      if (recapResult.ok && recapResult.content) {
        try {
          recapData = JSON.parse(extractJson(recapResult.content));
          // Save the customer email as a draft
          if (recapData.customer_email) {
            const { error: draftErr } = await supabase.from("drafts").insert({
              lead_id: leadId,
              channel: "email",
              draft_type: kind === "call" ? "follow_up" : "post_meeting_followup",
              subject: recapData.customer_email.subject,
              body_text: recapData.customer_email.body,
              to_recipient: lead.email,
            });
            if (draftErr) {
              console.error("Failed to save follow-up draft:", draftErr);
              toast.warning("Couldn't save the follow-up email draft");
            } else {
              toast.success("Follow-up email draft saved to Drafts");
            }
          }
          // Durable summary on the timeline row: the AI context builders read
          // ai_summary first, so the gist survives even if the raw text is purged.
          const bullets: unknown = recapData.internal_recap_bullets;
          if (Array.isArray(bullets) && bullets.length) {
            await annotateInteractionAI(leadId, interactionId, {
              summary: bullets.map(String).join(" • ").slice(0, 1000),
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
      let analysisOk = false;
      if (deepResult.ok && deepResult.content) {
        try {
          const parsed = JSON.parse(extractJson(deepResult.content));
          milestonesData = { milestones: parsed.milestones || [], risks: parsed.risks || [] };
          factorsData = parsed.deal_factors || null;
          recsData = { recommendations: parsed.recommendations || [], best_next_step: parsed.best_next_step || null };
          analysisOk = true;
        } catch (e) {
          console.error("Failed to parse deep analysis:", e);
        }
      }

      // Failed / unparseable analysis: save nothing (neither canonical nor
      // mirror) so we never clear a good next step with an empty result.
      if (!analysisOk) {
        toast.error("Failed to save analysis to lead");
        return;
      }

      // Persist: canonical lead_intelligence first (milestones merged by text,
      // completed beats pending; deal factors merged — the recompute has no
      // other writer for them), then the leads mirror as before.
      try {
        await saveLeadDeepAnalysis(leadId, {
          milestones: milestonesData.milestones,
          risks: milestonesData.risks,
          dealFactors: factorsData,
          nextStep: recsData.best_next_step?.title || null,
          nextStepReason: recsData.best_next_step?.why || null,
          dealOutlook: factorsData?.overall_outlook || null,
        });
        toast.success(`${kind === "call" ? "Call" : "Meeting"} analysis complete — deal insights updated.`);
      } catch (updateError) {
        console.error("Failed to update lead:", updateError);
        toast.error("Failed to save analysis to lead");
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

    // Optional "when did this happen?" (local time). Empty = now.
    const occurred = occurredAt ? new Date(occurredAt) : new Date();
    if (Number.isNaN(occurred.getTime()) || occurred.getTime() > Date.now() + 60_000) {
      toast.error("Please pick a date and time that isn't in the future");
      return;
    }
    const occurredIso = occurred.toISOString();

    setIsSubmitting(true);

    try {
      // Insert the interaction — canonical timeline-first write. The returned
      // id is the stable identity used for both the timeline row
      // (dedupe_key='interaction:<id>') and the legacy mirror.
      const inserted = await insertInteraction(leadId, {
        type,
        subject: subject || undefined,
        from_email: fromEmail || undefined,
        to_email: toEmail || undefined,
        body_text: bodyText,
        occurred_at: occurredIso,
      });

      // Auto-update lead state. Stage only ever moves forward; timestamps only
      // move if this interaction is newer (or, for first outbound, older).
      const minStage = MIN_STAGE[type];
      if (minStage) {
        const { data: currentLead } = await supabase
          .from("leads")
          .select("stage, last_inbound_at, last_outbound_at, first_outbound_at")
          .eq("id", leadId)
          .single();

        const update: Record<string, string> = {};
        const stage = raiseStage(currentLead?.stage, minStage);
        if (stage !== currentLead?.stage) update.stage = stage;
        if (type === "email_inbound") update.last_inbound_at = later(currentLead?.last_inbound_at, occurredIso);
        if (type === "email_outbound") {
          update.last_outbound_at = later(currentLead?.last_outbound_at, occurredIso);
          update.first_outbound_at = earlier(currentLead?.first_outbound_at, occurredIso);
        }
        if (Object.keys(update).length) {
          await supabase.from("leads").update(update).eq("id", leadId);
        }
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
            const parsed = JSON.parse(extractJson(result.content));
            // Canonical-first AI annotation. Targets the exact row
            // `insertInteraction` just wrote (no fuzzy "latest by
            // occurred_at" lookup). Helper writes
            // `lead_timeline_items.metadata_json` / `status_json` as
            // primary, mirrors to legacy `interactions.ai_*` for
            // back-compat. See `annotateInteractionAI` for details.
            await annotateInteractionAI(leadId, inserted.id, {
              intent: parsed.intent_primary,
              summary: `${parsed.tone} tone, ${parsed.urgency} urgency. Strategy: ${parsed.suggested_strategy}`,
              reply_worthy: parsed.reply_worthy,
            });
            toast.success(`Email analyzed: ${parsed.intent_primary}, ${parsed.reply_worthy ? "reply needed" : "no reply needed"}`);
          } catch {
            console.error("Failed to parse intent router response");
          }
        }
      } else if (type === "meeting" || type === "call") {
        toast.success(`${type === "call" ? "Call" : "Meeting"} notes added. Starting AI analysis...`);
        await runRecapAndAnalysis(bodyText, type, inserted.id);
      } else {
        toast.success("Interaction added");
      }

      // Reset form
      setSubject("");
      setFromEmail("");
      setToEmail("");
      setBodyText("");
      setOccurredAt("");
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
          Upload an email, meeting notes, or call summary. Inbound emails are analyzed for intent. Meeting and call notes update deal insights and draft a follow-up email.
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

          <div className="space-y-2">
            <Label htmlFor="interaction-occurred-at">When did this happen? (optional)</Label>
            <Input
              id="interaction-occurred-at"
              type="datetime-local"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Leave empty for right now.</p>
          </div>

          {isAnalysedType && (
            <div className="p-3 bg-primary/10 rounded-lg flex items-start gap-2">
              <Brain className="h-5 w-5 text-primary mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-primary">AI Analysis Pipeline</p>
                <p className="text-muted-foreground">
                  {isMeetingType ? "Meeting" : "Call"} notes will automatically trigger: recap + follow-up email draft → milestones, risks and deal factors → next step recommendation
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
            {isRunningPipeline ? "Running AI Pipeline..." : isAnalyzing ? "Analyzing..." : isSubmitting ? "Saving..." : isMeetingType ? "Add & Analyze Meeting" : type === "call" ? "Add & Analyze Call" : "Add Interaction"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}