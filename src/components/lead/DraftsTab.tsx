import { useEffect, useState } from "react";
import { LeadDetail, getLeadDrafts, saveDraft, getKnowledgeChunks, getLeadInteractions, appendLeadMilestones, MilestoneItem } from "@/lib/supabaseQueries";
import { useAITask, AITaskType } from "@/hooks/useAITask";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Copy, Save, Mail, Linkedin, MessageSquare, Loader2, FileText, ChevronDown, ChevronUp, CheckCircle2, Clock, HelpCircle, PlusCircle, Scissors, Sparkles, Send } from "lucide-react";
import { format } from "date-fns";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SendEmailButton } from "@/components/gmail/SendEmailButton";
import { EmailTemplateSelector } from "@/components/lead/EmailTemplateSelector";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NurtureSequenceOutput } from "@/schemas/llmOutputSchemas";

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

type NurtureTheme = "technical" | "use_case" | "roi" | "compliance";
type NurtureCadence = "weekly" | "biweekly" | "monthly";
type ShortenTarget = "80%" | "60%" | "40%" | "5_lines";
type PostMeetingGoal = "technical" | "sdk" | "security" | "procurement" | "qa";

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
  const [editableCustomerEmail, setEditableCustomerEmail] = useState("");
  const [isSavingMilestones, setIsSavingMilestones] = useState(false);

  // Nurture sequence state
  const [nurtureTheme, setNurtureTheme] = useState<NurtureTheme>("use_case");
  const [nurtureCadence, setNurtureCadence] = useState<NurtureCadence>("biweekly");
  const [nurtureResult, setNurtureResult] = useState<NurtureSequenceOutput | null>(null);

  // Shorten draft state
  const [shortenInput, setShortenInput] = useState("");
  const [shortenTarget, setShortenTarget] = useState<ShortenTarget>("60%");

  // Post-meeting personalized state
  const [postMeetingGoal, setPostMeetingGoal] = useState<PostMeetingGoal>("technical");

  // Pre-meeting email summary for follow-ups
  const [previousEmailSummary, setPreviousEmailSummary] = useState("");

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
    const parts = [
      `Name: ${lead.name}`,
      `Company: ${lead.company}`,
      `Email: ${lead.email}`,
      lead.job_title && `Job Title: ${lead.job_title}`,
      lead.industry && `Industry: ${lead.industry}`,
      lead.country && `Country: ${lead.country}`,
      lead.phone && `Phone: ${lead.phone}`,
      `Strategy: ${lead.strategy}`,
      `Status: ${lead.status}`,
      lead.initial_message && `Initial Message from Lead: ${lead.initial_message}`,
      lead.personal_notes && `Notes: ${lead.personal_notes}`,
    ].filter(Boolean);
    return parts.join("\n");
  };

  // Pre-Meeting Cadence Emails
  const generatePreMeetingEmail = async (emailNum: 1 | 2 | 3 | 4) => {
    const taskMap: Record<number, AITaskType> = {
      1: "pre_email_1_intro",
      2: "pre_email_2_followup",
      3: "pre_email_3_followup",
      4: "pre_email_4_breakup",
    };
    
    const kb = await getKnowledgeChunks(true);
    const payload: Record<string, unknown> = {
      lead_context: buildLeadContext(),
      meeting_link: lead.meeting_link || "",
    };

    if (emailNum === 1 || emailNum === 2) {
      payload.knowledge_context = kb.map((k) => k.content).join("\n---\n");
    }
    if (emailNum === 2 || emailNum === 3) {
      payload.previous_email_summary = previousEmailSummary || "Previous outreach introducing our solution.";
    }

    const result = await runTask(taskMap[emailNum], payload);
    if (result.ok && result.content) {
      setGeneratedContent(result.content);
      setGeneratedType(`pre_email_${emailNum}`);
    }
  };

  // Legacy intro email (strategy-based)
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

  // LinkedIn
  const generateLinkedInConnect = async () => {
    const result = await runTask("linkedin_connect", {
      prospect_name: lead.name,
      title: lead.job_title || "",
      company: lead.company,
      context: [
        lead.industry && `Industry: ${lead.industry}`,
        lead.country && `Location: ${lead.country}`,
        lead.initial_message && `Their message: ${lead.initial_message}`,
        lead.personal_notes && `Notes: ${lead.personal_notes}`,
      ].filter(Boolean).join(". ") || `B2B sales outreach for ${lead.company}`,
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
      title: lead.job_title || "",
      company: lead.company,
      context: [
        lead.industry && `Industry: ${lead.industry}`,
        lead.country && `Location: ${lead.country}`,
        lead.initial_message && `Their message: ${lead.initial_message}`,
        lead.personal_notes && `Notes: ${lead.personal_notes}`,
      ].filter(Boolean).join(". ") || `B2B sales outreach for ${lead.company}`,
      knowledge_context: kb.map((k) => k.content).join("\n---\n"),
    });

    if (result.ok && result.content) {
      setGeneratedContent(result.content);
      setGeneratedType("linkedin_followup");
    }
  };

  // Answer Questions
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

  // Post-Meeting Recap
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

  // Post-Meeting Personalized Follow-up
  const generatePersonalizedFollowup = async () => {
    const kb = await getKnowledgeChunks(true);
    const result = await runTask("post_meeting_followup_personalized", {
      lead_context: buildLeadContext(),
      goal: postMeetingGoal,
      knowledge_context: kb.map((k) => k.content).join("\n---\n"),
      meeting_link: lead.meeting_link || "",
    });

    if (result.ok && result.content) {
      setGeneratedContent(result.content);
      setGeneratedType(`followup_${postMeetingGoal}`);
    }
  };

  // Nurture Sequence
  const generateNurtureSequence = async () => {
    const kb = await getKnowledgeChunks(true);
    const result = await runTask("nurture_sequence", {
      lead_context: buildLeadContext(),
      theme: nurtureTheme,
      cadence: nurtureCadence,
      knowledge_context: kb.map((k) => k.content).join("\n---\n"),
    });

    if (result.ok && result.content) {
      try {
        const parsed = JSON.parse(result.content) as NurtureSequenceOutput;
        setNurtureResult(parsed);
        toast.success(`Generated ${parsed.emails.length} nurture emails`);
      } catch {
        setGeneratedContent(result.content);
        setGeneratedType("nurture_sequence");
      }
    }
  };

  // Shorten Draft
  const shortenDraft = async () => {
    if (!shortenInput.trim()) {
      toast.error("Please enter text to shorten");
      return;
    }
    const result = await runTask("shorten_draft", {
      draft_text: shortenInput,
      target: shortenTarget,
    });

    if (result.ok && result.content) {
      setGeneratedContent(result.content);
      setGeneratedType("shortened");
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

  const saveAsDraft = async (content?: string, type?: string, subject?: string) => {
    const contentToSave = content || generatedContent;
    const typeToSave = type || generatedType;
    const subjectToSave = subject || generatedSubject;
    const isLinkedIn = typeToSave.includes("linkedin");
    
    try {
      await saveDraft(lead.id, {
        channel: isLinkedIn ? "linkedin" : "email",
        draft_type: typeToSave,
        subject: subjectToSave || undefined,
        body_text: contentToSave,
        to_recipient: lead.email,
      });
      toast.success("Draft saved");
      if (!content) {
        setGeneratedContent("");
        setGeneratedSubject("");
        setGeneratedType("");
      }
      loadDrafts();
    } catch {
      toast.error("Failed to save draft");
    }
  };

  return (
    <div className="space-y-6">
      {/* Main Drafts Generator */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Generate Drafts
          </CardTitle>
          <CardDescription>AI-powered email and LinkedIn content generation</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="pre-meeting" className="w-full">
            <TabsList className="grid w-full grid-cols-5 mb-4">
              <TabsTrigger value="pre-meeting">Pre-Meeting</TabsTrigger>
              <TabsTrigger value="post-meeting">Post-Meeting</TabsTrigger>
              <TabsTrigger value="linkedin">LinkedIn</TabsTrigger>
              <TabsTrigger value="nurture">Nurture</TabsTrigger>
              <TabsTrigger value="utility">Utility</TabsTrigger>
            </TabsList>

            {/* Pre-Meeting Tab */}
            <TabsContent value="pre-meeting" className="space-y-4">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <EmailTemplateSelector 
                    lead={lead} 
                    onSelectTemplate={(subject, body) => {
                      setGeneratedSubject(subject);
                      setGeneratedContent(body);
                      setGeneratedType("template_email");
                    }}
                  />
                  <Button onClick={generateIntroEmail} disabled={isGenerating} variant="outline">
                    {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
                    Smart Intro ({lead.strategy})
                  </Button>
                </div>

                <div className="border rounded-lg p-4 space-y-3">
                  <h4 className="text-sm font-medium">Pre-Meeting Email Cadence</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <Button onClick={() => generatePreMeetingEmail(1)} disabled={isGenerating} size="sm">
                      {isGenerating ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                      Email 1: Intro
                    </Button>
                    <Button onClick={() => generatePreMeetingEmail(2)} disabled={isGenerating} size="sm" variant="outline">
                      {isGenerating ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                      Email 2: Follow-up
                    </Button>
                    <Button onClick={() => generatePreMeetingEmail(3)} disabled={isGenerating} size="sm" variant="outline">
                      {isGenerating ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                      Email 3: Check-in
                    </Button>
                    <Button onClick={() => generatePreMeetingEmail(4)} disabled={isGenerating} size="sm" variant="outline">
                      {isGenerating ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                      Email 4: Breakup
                    </Button>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Previous email summary (for follow-ups)</label>
                    <Input
                      value={previousEmailSummary}
                      onChange={(e) => setPreviousEmailSummary(e.target.value)}
                      placeholder="Brief summary of what was sent before..."
                      className="text-sm"
                    />
                  </div>
                </div>

                <Button onClick={generateFollowupSequence} disabled={isGenerating} variant="secondary" className="w-full">
                  {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
                  Generate Full 4-Email Sequence
                </Button>
              </div>
            </TabsContent>

            {/* Post-Meeting Tab */}
            <TabsContent value="post-meeting" className="space-y-4">
              <div className="space-y-4">
                {/* Meeting Notes Recap */}
                <div className="border rounded-lg p-4 space-y-3">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Full Recap from Notes
                  </h4>
                  <Textarea
                    placeholder="Paste or type your meeting notes here..."
                    value={meetingNotes}
                    onChange={(e) => setMeetingNotes(e.target.value)}
                    rows={4}
                    className="resize-none"
                  />
                  <Button onClick={generatePostMeetingRecap} disabled={isGenerating || !meetingNotes.trim()} className="w-full">
                    {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileText className="h-4 w-4 mr-2" />}
                    Generate Recap + Follow-up Email
                  </Button>
                </div>

                {/* Personalized Follow-up */}
                <div className="border rounded-lg p-4 space-y-3">
                  <h4 className="text-sm font-medium">Personalized Follow-up Email</h4>
                  <p className="text-xs text-muted-foreground">Generate a focused follow-up based on a specific goal</p>
                  <div className="flex gap-2">
                    <Select value={postMeetingGoal} onValueChange={(v) => setPostMeetingGoal(v as PostMeetingGoal)}>
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="technical">Technical Deep-dive</SelectItem>
                        <SelectItem value="sdk">SDK / Integration</SelectItem>
                        <SelectItem value="security">Security / Compliance</SelectItem>
                        <SelectItem value="procurement">Procurement / Legal</SelectItem>
                        <SelectItem value="qa">Answer Questions</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button onClick={generatePersonalizedFollowup} disabled={isGenerating} className="flex-1">
                      {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
                      Generate
                    </Button>
                  </div>
                </div>

                {/* Answer Questions */}
                <div className="border rounded-lg p-4 space-y-3">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    Answer Prospect Questions
                  </h4>
                  <div className="flex gap-2">
                    <Textarea
                      placeholder="Enter questions to answer using knowledge base..."
                      value={questionInput}
                      onChange={(e) => setQuestionInput(e.target.value)}
                      className="flex-1"
                      rows={2}
                    />
                    <Button onClick={answerQuestion} disabled={isGenerating || !questionInput.trim()} className="self-end">
                      {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Recap Results */}
              {recapResult && (
                <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium">Generated Recap</h4>
                    <Button variant="ghost" size="sm" onClick={copyInternalRecap}>
                      <Copy className="h-3 w-3 mr-1" />
                      Copy Internal Notes
                    </Button>
                  </div>

                  {/* Internal Recap */}
                  <div className="space-y-2">
                    <h5 className="text-sm font-medium flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      Internal Recap
                    </h5>
                    <div className="bg-background rounded-lg p-3 space-y-1">
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
                      <h5 className="text-sm font-medium flex items-center gap-2">
                        <HelpCircle className="h-4 w-4 text-amber-500" />
                        Open Questions
                      </h5>
                      <div className="bg-amber-500/10 rounded-lg p-3 space-y-1">
                        {recapResult.open_questions.map((q, i) => (
                          <p key={i} className="text-sm flex gap-2">
                            <span className="text-amber-500">?</span>
                            {q}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Milestones */}
                  {recapResult.milestones_from_meeting.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h5 className="text-sm font-medium flex items-center gap-2">
                          <Clock className="h-4 w-4 text-blue-500" />
                          Milestones
                        </h5>
                        <Button variant="outline" size="sm" onClick={addMilestonesToLead} disabled={isSavingMilestones}>
                          {isSavingMilestones ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <PlusCircle className="h-3 w-3 mr-1" />}
                          Add to Lead
                        </Button>
                      </div>
                      <div className="space-y-1">
                        {recapResult.milestones_from_meeting.map((m, i) => (
                          <div key={i} className="flex items-center gap-2 p-2 bg-background rounded">
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
                    <h5 className="text-sm font-medium flex items-center gap-2">
                      <Mail className="h-4 w-4 text-primary" />
                      Customer Follow-up Email
                    </h5>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-muted-foreground">Subject:</span>
                        <span className="text-sm">{recapResult.customer_email.subject}</span>
                      </div>
                      <Textarea
                        value={editableCustomerEmail}
                        onChange={(e) => setEditableCustomerEmail(e.target.value)}
                        rows={6}
                        className="font-mono text-sm"
                      />
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => {
                          navigator.clipboard.writeText(editableCustomerEmail);
                          toast.success("Email copied to clipboard");
                        }}>
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
            </TabsContent>

            {/* LinkedIn Tab */}
            <TabsContent value="linkedin" className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Button onClick={generateLinkedInConnect} disabled={isGenerating} className="h-auto py-4 flex-col gap-1">
                  {isGenerating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Linkedin className="h-5 w-5" />}
                  <span>Connection Request</span>
                  <span className="text-xs text-muted-foreground font-normal">&lt;300 chars</span>
                </Button>
                <Button onClick={generateLinkedInFollowup} disabled={isGenerating} variant="outline" className="h-auto py-4 flex-col gap-1">
                  {isGenerating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Linkedin className="h-5 w-5" />}
                  <span>Follow-up Message</span>
                  <span className="text-xs text-muted-foreground font-normal">&lt;600 chars</span>
                </Button>
              </div>
            </TabsContent>

            {/* Nurture Tab */}
            <TabsContent value="nurture" className="space-y-4">
              <div className="border rounded-lg p-4 space-y-4">
                <h4 className="text-sm font-medium">Nurture Email Sequence</h4>
                <p className="text-xs text-muted-foreground">Generate a value-driven email sequence to maintain engagement over time</p>
                
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Theme</label>
                    <Select value={nurtureTheme} onValueChange={(v) => setNurtureTheme(v as NurtureTheme)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="technical">Technical Education</SelectItem>
                        <SelectItem value="use_case">Use Case Stories</SelectItem>
                        <SelectItem value="roi">ROI & Business Value</SelectItem>
                        <SelectItem value="compliance">Compliance & Security</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Cadence</label>
                    <Select value={nurtureCadence} onValueChange={(v) => setNurtureCadence(v as NurtureCadence)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="biweekly">Bi-weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Button onClick={generateNurtureSequence} disabled={isGenerating} className="w-full">
                  {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                  Generate 3-6 Email Nurture Sequence
                </Button>
              </div>

              {/* Nurture Results */}
              {nurtureResult && (
                <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium">Generated Sequence: {nurtureResult.theme}</h4>
                    <Badge>{nurtureResult.cadence}</Badge>
                  </div>
                  <div className="space-y-3">
                    {nurtureResult.emails.map((email, i) => (
                      <div key={i} className="bg-background rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <Badge variant="outline">Email {email.email_number}</Badge>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" onClick={() => {
                              navigator.clipboard.writeText(email.body);
                              toast.success("Copied");
                            }}>
                              <Copy className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => saveAsDraft(email.body, `nurture_${email.email_number}`, email.subject)}>
                              <Save className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                        <p className="text-sm font-medium">{email.subject}</p>
                        <p className="text-sm text-muted-foreground line-clamp-3">{email.body}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </TabsContent>

            {/* Utility Tab */}
            <TabsContent value="utility" className="space-y-4">
              <div className="border rounded-lg p-4 space-y-3">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <Scissors className="h-4 w-4" />
                  Shorten Draft
                </h4>
                <p className="text-xs text-muted-foreground">Reduce length while preserving meaning and CTA</p>
                
                <Textarea
                  placeholder="Paste the text you want to shorten..."
                  value={shortenInput}
                  onChange={(e) => setShortenInput(e.target.value)}
                  rows={4}
                />
                
                <div className="flex gap-2">
                  <Select value={shortenTarget} onValueChange={(v) => setShortenTarget(v as ShortenTarget)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="80%">80% length</SelectItem>
                      <SelectItem value="60%">60% length</SelectItem>
                      <SelectItem value="40%">40% length</SelectItem>
                      <SelectItem value="5_lines">5 lines max</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button onClick={shortenDraft} disabled={isGenerating || !shortenInput.trim()} className="flex-1">
                    {isGenerating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Scissors className="h-4 w-4 mr-2" />}
                    Shorten
                  </Button>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Generated Content */}
      {generatedContent && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Generated: {generatedType.replace(/_/g, ' ')}</CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={copyToClipboard}>
                  <Copy className="h-4 w-4 mr-1" />
                  Copy
                </Button>
                <Button size="sm" onClick={() => saveAsDraft()}>
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
                <Input
                  type="text"
                  value={generatedSubject}
                  onChange={(e) => setGeneratedSubject(e.target.value)}
                  className="mt-1"
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
