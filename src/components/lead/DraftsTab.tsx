import { useEffect, useState } from "react";
import { LeadDetail, getLeadDrafts, saveDraft, getKnowledgeChunks, getLeadInteractions, appendLeadMilestones, MilestoneItem } from "@/lib/supabaseQueries";
import { useAITask } from "@/hooks/useAITask";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Copy, Save, Mail, Linkedin, MessageSquare, Loader2, FileText, ChevronDown, ChevronUp, CheckCircle2, Clock, HelpCircle, PlusCircle } from "lucide-react";
import { format } from "date-fns";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SendEmailButton } from "@/components/gmail/SendEmailButton";
import { EmailTemplateSelector } from "@/components/lead/EmailTemplateSelector";

interface DraftsTabProps {
  lead: LeadDetail;
  onUpdate: () => void;
}

interface Draft {
  id: string;
  draft_type: string;
  channel: string;
  subject: string | null;
  body_text: string;
  status: string;
  created_at: string;
}

interface PostMeetingRecapResult {
  internal_recap_bullets: string[];
  milestones_from_meeting: MilestoneItem[];
  open_questions: string[];
  customer_email: {
    subject: string;
    body: string;
  };
}

export default function DraftsTab({ lead, onUpdate }: DraftsTabProps) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [generatedContent, setGeneratedContent] = useState<string>("");
  const [generatedSubject, setGeneratedSubject] = useState<string>("");
  const [generatedType, setGeneratedType] = useState<string>("");
  const [questionInput, setQuestionInput] = useState("");
  const { runTask, isLoading: isGenerating } = useAITask();

  // Post-meeting recap state
  const [meetingNotes, setMeetingNotes] = useState("");
  const [recapResult, setRecapResult] = useState<PostMeetingRecapResult | null>(null);
  const [showRecapSection, setShowRecapSection] = useState(false);
  const [editableCustomerEmail, setEditableCustomerEmail] = useState("");
  const [isSavingMilestones, setIsSavingMilestones] = useState(false);

  const loadDrafts = async () => {
    try {
      const data = await getLeadDrafts(lead.id);
      setDrafts(data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDrafts();
  }, [lead.id]);

  const buildLeadContext = () => {
    return `Name: ${lead.name}
Company: ${lead.company}
Email: ${lead.email}
Strategy: ${lead.strategy}
Status: ${lead.status}
${lead.personal_notes ? `Notes: ${lead.personal_notes}` : ""}`;
  };

  const generateIntroEmail = async () => {
    const task = lead.strategy === "fast" ? "email_intro_fast" : "email_intro_nurture";
    const kb = await getKnowledgeChunks(true);
    const interactions = await getLeadInteractions(lead.id);
    const lastInbound = interactions.find((i) => i.type === "email_inbound");

    const result = await runTask(task, {
      lead_context: buildLeadContext(),
      email_text: lastInbound?.body_text || "",
      knowledge_context: kb.map((k) => k.content).join("\n---\n"),
      meeting_link: lead.meeting_link || "",
    });

    if (result.ok && result.content) {
      setGeneratedContent(result.content);
      setGeneratedType("intro_email");
    }
  };

  const generateFollowupSequence = async () => {
    const kb = await getKnowledgeChunks(true);
    const result = await runTask("followup_sequence_4", {
      mode: lead.strategy,
      lead_context: buildLeadContext(),
      sent_so_far: "",
      knowledge_context: kb.map((k) => k.content).join("\n---\n"),
      meeting_link: lead.meeting_link || "",
    });

    if (result.ok && result.content) {
      setGeneratedContent(result.content);
      setGeneratedType("followup_sequence");
    }
  };

  const generateLinkedInConnect = async () => {
    const result = await runTask("linkedin_connect", {
      prospect_name: lead.name,
      title: "",
      company: lead.company,
      context: lead.personal_notes || `B2B sales outreach for ${lead.company}`,
    });

    if (result.ok && result.content) {
      setGeneratedContent(result.content);
      setGeneratedType("linkedin_connect");
    }
  };

  const generateLinkedInFollowup = async () => {
    const kb = await getKnowledgeChunks(true);
    const result = await runTask("linkedin_followup", {
      prospect_name: lead.name,
      title: "",
      company: lead.company,
      context: lead.personal_notes || `B2B sales outreach for ${lead.company}`,
      knowledge_context: kb.map((k) => k.content).join("\n---\n"),
    });

    if (result.ok && result.content) {
      setGeneratedContent(result.content);
      setGeneratedType("linkedin_followup");
    }
  };

  const answerQuestion = async () => {
    if (!questionInput.trim()) {
      toast.error("Please enter a question");
      return;
    }
    const kb = await getKnowledgeChunks(true);
    const result = await runTask("answer_questions", {
      lead_context: buildLeadContext(),
      questions_list: questionInput,
      knowledge_context: kb.map((k) => k.content).join("\n---\n"),
      meeting_link: lead.meeting_link || "",
    });

    if (result.ok && result.content) {
      setGeneratedContent(result.content);
      setGeneratedType("answer");
      setQuestionInput("");
    }
  };

  const generatePostMeetingRecap = async () => {
    if (!meetingNotes.trim()) {
      toast.error("Please enter meeting notes");
      return;
    }

    const kb = await getKnowledgeChunks(true);
    const result = await runTask("post_meeting_recap", {
      mode: lead.strategy,
      lead_context: buildLeadContext(),
      meeting_summary: meetingNotes,
      knowledge_context: kb.map((k) => k.content).join("\n---\n"),
      meeting_link: lead.meeting_link || "",
    });

    if (result.ok && result.content) {
      try {
        const parsed = JSON.parse(result.content) as PostMeetingRecapResult;
        setRecapResult(parsed);
        setEditableCustomerEmail(parsed.customer_email.body);
        toast.success("Recap generated successfully");
      } catch {
        toast.error("Failed to parse recap result");
      }
    }
  };

  const copyInternalRecap = () => {
    if (!recapResult) return;
    const text = [
      "## Internal Recap",
      ...recapResult.internal_recap_bullets.map(b => `• ${b}`),
      "",
      "## Open Questions",
      ...recapResult.open_questions.map(q => `• ${q}`),
      "",
      "## Milestones",
      ...recapResult.milestones_from_meeting.map(m => `• [${m.status}] ${m.description}${m.date ? ` (${m.date})` : ""}`),
    ].join("\n");
    navigator.clipboard.writeText(text);
    toast.success("Internal recap copied to clipboard");
  };

  const saveCustomerEmailDraft = async () => {
    if (!recapResult) return;
    try {
      await saveDraft(lead.id, {
        channel: "email",
        draft_type: "post_meeting_followup",
        subject: recapResult.customer_email.subject,
        body_text: editableCustomerEmail,
        to_recipient: lead.email,
      });
      toast.success("Customer email saved as draft");
      loadDrafts();
    } catch {
      toast.error("Failed to save draft");
    }
  };

  const addMilestonesToLead = async () => {
    if (!recapResult?.milestones_from_meeting.length) return;
    setIsSavingMilestones(true);
    try {
      await appendLeadMilestones(lead.id, recapResult.milestones_from_meeting);
      toast.success("Milestones added to lead");
      onUpdate();
    } catch {
      toast.error("Failed to add milestones");
    } finally {
      setIsSavingMilestones(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generatedContent);
    toast.success("Copied to clipboard");
  };

  const saveAsDraft = async () => {
    const isLinkedIn = generatedType.includes("linkedin");
    try {
      await saveDraft(lead.id, {
        channel: isLinkedIn ? "linkedin" : "email",
        draft_type: generatedType,
        subject: generatedSubject || undefined,
        body_text: generatedContent,
        to_recipient: lead.email,
      });
      toast.success("Draft saved");
      setGeneratedContent("");
      setGeneratedSubject("");
      setGeneratedType("");
      loadDrafts();
    } catch {
      toast.error("Failed to save draft");
    }
  };

  return (
    <div className="space-y-6">
      {/* Generate Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Generate Drafts</CardTitle>
          <CardDescription>Use AI to generate email and LinkedIn drafts</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <EmailTemplateSelector 
              lead={lead} 
              onSelectTemplate={(subject, body) => {
                setGeneratedSubject(subject);
                setGeneratedContent(body);
                setGeneratedType("template_email");
              }}
            />
            <Button onClick={generateIntroEmail} disabled={isGenerating}>
              {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
              Intro Email ({lead.strategy})
            </Button>
            <Button onClick={generateFollowupSequence} disabled={isGenerating} variant="outline">
              {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
              Follow-up Sequence
            </Button>
            <Button onClick={generateLinkedInConnect} disabled={isGenerating} variant="outline">
              {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Linkedin className="h-4 w-4 mr-2" />}
              LinkedIn Connect
            </Button>
            <Button onClick={generateLinkedInFollowup} disabled={isGenerating} variant="outline">
              {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Linkedin className="h-4 w-4 mr-2" />}
              LinkedIn Follow-up
            </Button>
          </div>

          <div className="flex gap-2">
            <Textarea
              placeholder="Enter a question to answer..."
              value={questionInput}
              onChange={(e) => setQuestionInput(e.target.value)}
              className="flex-1"
            />
            <Button onClick={answerQuestion} disabled={isGenerating || !questionInput.trim()}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Post-Meeting Recap */}
      <Card>
        <Collapsible open={showRecapSection} onOpenChange={setShowRecapSection}>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle>Post-Meeting Recap</CardTitle>
                    <CardDescription>Generate internal summary and customer follow-up email</CardDescription>
                  </div>
                </div>
                {showRecapSection ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Meeting Notes</label>
                <Textarea
                  placeholder="Enter your meeting notes, key discussion points, action items, and any important details..."
                  value={meetingNotes}
                  onChange={(e) => setMeetingNotes(e.target.value)}
                  rows={6}
                  className="resize-none"
                />
              </div>
              <Button 
                onClick={generatePostMeetingRecap} 
                disabled={isGenerating || !meetingNotes.trim()}
                className="w-full"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating Recap...
                  </>
                ) : (
                  <>
                    <FileText className="h-4 w-4 mr-2" />
                    Generate Recap
                  </>
                )}
              </Button>

              {/* Recap Results */}
              {recapResult && (
                <div className="space-y-4 pt-4 border-t">
                  {/* Internal Recap */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="font-medium flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                        Internal Recap
                      </h4>
                      <Button variant="ghost" size="sm" onClick={copyInternalRecap}>
                        <Copy className="h-3 w-3 mr-1" />
                        Copy All
                      </Button>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                      {recapResult.internal_recap_bullets.map((bullet, i) => (
                        <p key={i} className="text-sm flex gap-2">
                          <span className="text-primary">•</span>
                          {bullet}
                        </p>
                      ))}
                    </div>
                  </div>

                  {/* Open Questions */}
                  {recapResult.open_questions.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="font-medium flex items-center gap-2">
                        <HelpCircle className="h-4 w-4 text-amber-500" />
                        Open Questions
                      </h4>
                      <div className="bg-amber-500/10 rounded-lg p-3 space-y-2">
                        {recapResult.open_questions.map((q, i) => (
                          <p key={i} className="text-sm flex gap-2">
                            <span className="text-amber-500">?</span>
                            {q}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Milestones from Meeting */}
                  {recapResult.milestones_from_meeting.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium flex items-center gap-2">
                          <Clock className="h-4 w-4 text-blue-500" />
                          Milestones from Meeting
                        </h4>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={addMilestonesToLead}
                          disabled={isSavingMilestones}
                        >
                          {isSavingMilestones ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <PlusCircle className="h-3 w-3 mr-1" />
                          )}
                          Add to Lead
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {recapResult.milestones_from_meeting.map((m, i) => (
                          <div key={i} className="flex items-center gap-2 p-2 bg-muted/50 rounded">
                            <Badge variant={m.status === "completed" ? "default" : "secondary"} className="text-xs">
                              {m.status}
                            </Badge>
                            <span className="text-sm flex-1">{m.description}</span>
                            {m.date && <span className="text-xs text-muted-foreground">{m.date}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Customer Email */}
                  <div className="space-y-2 pt-2 border-t">
                    <h4 className="font-medium flex items-center gap-2">
                      <Mail className="h-4 w-4 text-primary" />
                      Customer Follow-up Email
                    </h4>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-muted-foreground">Subject:</span>
                        <span className="text-sm">{recapResult.customer_email.subject}</span>
                      </div>
                      <Textarea
                        value={editableCustomerEmail}
                        onChange={(e) => setEditableCustomerEmail(e.target.value)}
                        rows={8}
                        className="font-mono text-sm"
                      />
                      <div className="flex gap-2">
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => {
                            navigator.clipboard.writeText(editableCustomerEmail);
                            toast.success("Email copied to clipboard");
                          }}
                        >
                          <Copy className="h-3 w-3 mr-1" />
                          Copy
                        </Button>
                        <Button size="sm" onClick={saveCustomerEmailDraft}>
                          <Save className="h-3 w-3 mr-1" />
                          Save as Draft
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* Generated Content */}
      {generatedContent && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Generated: {generatedType}</CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={copyToClipboard}>
                  <Copy className="h-4 w-4 mr-1" />
                  Copy
                </Button>
                <Button size="sm" onClick={saveAsDraft}>
                  <Save className="h-4 w-4 mr-1" />
                  Save Draft
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {generatedSubject && (
              <div>
                <label className="text-sm font-medium text-muted-foreground">Subject</label>
                <input
                  type="text"
                  value={generatedSubject}
                  onChange={(e) => setGeneratedSubject(e.target.value)}
                  className="w-full mt-1 px-3 py-2 text-sm border rounded-md bg-background"
                />
              </div>
            )}
            <Textarea
              value={generatedContent}
              onChange={(e) => setGeneratedContent(e.target.value)}
              rows={10}
              className="font-mono text-sm"
            />
          </CardContent>
        </Card>
      )}

      {/* Saved Drafts */}
      <Card>
        <CardHeader>
          <CardTitle>Saved Drafts</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : drafts.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">No drafts saved yet</p>
          ) : (
            <div className="space-y-3">
              {drafts.map((draft) => (
                <div key={draft.id} className="p-3 border rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline">{draft.channel}</Badge>
                    <Badge variant="secondary">{draft.draft_type}</Badge>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {format(new Date(draft.created_at), "MMM d, h:mm a")}
                    </span>
                  </div>
                  {draft.subject && <p className="text-sm font-medium mb-1">{draft.subject}</p>}
                  <p className="text-sm text-muted-foreground line-clamp-3">{draft.body_text}</p>
                  <div className="flex gap-2 mt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(draft.body_text);
                        toast.success("Copied to clipboard");
                      }}
                    >
                      <Copy className="h-3 w-3 mr-1" />
                      Copy
                    </Button>
                    {draft.channel === "email" && draft.status !== "sent" && (
                      <SendEmailButton
                        to={lead.email}
                        subject={draft.subject || ""}
                        body={draft.body_text}
                        leadId={lead.id}
                        draftId={draft.id}
                        onSent={loadDrafts}
                        variant="outline"
                        size="sm"
                      />
                    )}
                    {draft.status === "sent" && (
                      <Badge variant="secondary" className="bg-green-500/10 text-green-600">
                        Sent
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
