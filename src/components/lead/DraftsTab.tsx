import { useEffect, useState } from "react";
import { LeadDetail, getLeadDrafts, saveDraft, getKnowledgeChunks, getLeadInteractions } from "@/lib/supabaseQueries";
import { useAITask } from "@/hooks/useAITask";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Copy, Save, Mail, Linkedin, MessageSquare, Loader2 } from "lucide-react";
import { format } from "date-fns";

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

export default function DraftsTab({ lead, onUpdate }: DraftsTabProps) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [generatedContent, setGeneratedContent] = useState<string>("");
  const [generatedType, setGeneratedType] = useState<string>("");
  const [questionInput, setQuestionInput] = useState("");
  const { runTask, isLoading: isGenerating } = useAITask();

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
        body_text: generatedContent,
        to_recipient: lead.email,
      });
      toast.success("Draft saved");
      setGeneratedContent("");
      setGeneratedType("");
      loadDrafts();
    } catch (err) {
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
          <CardContent>
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      navigator.clipboard.writeText(draft.body_text);
                      toast.success("Copied to clipboard");
                    }}
                  >
                    <Copy className="h-3 w-3 mr-1" />
                    Copy
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
