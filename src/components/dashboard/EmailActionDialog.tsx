import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { 
  Loader2, 
  Send, 
  ExternalLink, 
  RefreshCw, 
  ChevronDown,
  ChevronRight,
  BookOpen 
} from "lucide-react";
import { useAITask, AITaskType } from "@/hooks/useAITask";
import { useGmailSync } from "@/hooks/useGmailSync";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { getLeadEmailThread, getLeadDetail } from "@/lib/supabaseQueries";
import { toast } from "sonner";
import { EnrichedLead, getActionType } from "@/lib/dashboardUtils";

interface EmailActionDialogProps {
  lead: EnrichedLead;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss?: () => void;
}

// Map action types to AI tasks
function getAITaskForAction(actionKey: string | null, hasThread: boolean): AITaskType {
  const actionType = getActionType(actionKey);
  
  switch (actionType) {
    case "reply":
      return hasThread ? "reply_to_thread" : "email_intro_fast";
    case "recap":
      return "post_meeting_followup_email";
    case "follow_up":
      if (actionKey?.startsWith("send_pre_2")) return "pre_email_2_followup";
      if (actionKey?.startsWith("send_pre_3")) return "pre_email_3_followup";
      if (actionKey?.startsWith("send_pre_4")) return "pre_email_4_breakup";
      return "pre_email_2_followup";
    case "nurture":
      return "nurture_email_single";
    default:
      return "email_intro_fast";
  }
}

export function EmailActionDialog({
  lead,
  open,
  onOpenChange,
  onDismiss,
}: EmailActionDialogProps) {
  const [to, setTo] = useState(lead.email);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [threadContext, setThreadContext] = useState<string[]>([]);
  const [showThread, setShowThread] = useState(false);
  const [knowledgeUsed, setKnowledgeUsed] = useState(false);
  
  const { runTask } = useAITask();
  const { sendEmail, isSyncing } = useGmailSync();
  const { isConnected } = useGmailConnection();

  // Generate email when dialog opens
  useEffect(() => {
    if (open) {
      generateEmail();
    }
  }, [open, lead.id]);

  async function generateEmail() {
    setIsGenerating(true);
    setBody("");
    setSubject("");
    setKnowledgeUsed(false);

    try {
      // Fetch email thread for context
      const { emails, threadSummary } = await getLeadEmailThread(lead.id, 5);
      setThreadContext(emails.map(e => 
        `[${e.direction === 'inbound' ? 'From' : 'To'}: ${e.from_email}]\nSubject: ${e.subject || 'No subject'}\n${e.body_text?.slice(0, 300)}...`
      ));

      const hasThread = emails.length > 0;
      const taskType = getAITaskForAction(lead.next_action_key, hasThread);
      
      // Get full lead details for better context
      let leadDetail;
      try {
        leadDetail = await getLeadDetail(lead.id);
      } catch {
        leadDetail = lead;
      }

      // Build lead context
      const leadContext = `
Name: ${lead.name}
Company: ${lead.company}
Email: ${lead.email}
Strategy: ${lead.strategy || 'not set'}
Stage: ${lead.stage}
${leadDetail.job_title ? `Title: ${leadDetail.job_title}` : ''}
${leadDetail.industry ? `Industry: ${leadDetail.industry}` : ''}
${leadDetail.personal_notes ? `Notes: ${leadDetail.personal_notes}` : ''}
`.trim();

      // Prepare payload based on task type
      const payload: Record<string, unknown> = {
        lead_id: lead.id,
        lead_context: leadContext,
        meeting_link: leadDetail.meeting_link || '',
      };

      // Add thread context for replies
      if (hasThread && taskType === "reply_to_thread") {
        payload.email_thread = threadSummary;
        payload.latest_inbound = emails.find(e => e.direction === 'inbound')?.body_text || '';
      }

      // Add previous email summary for follow-ups
      if (taskType.includes("pre_email")) {
        payload.previous_email_summary = threadSummary || "No previous emails sent yet.";
      }

      // For nurture emails
      if (taskType === "nurture_email_single") {
        payload.theme = "use_case";
        payload.email_number = 1;
        payload.previous_emails = threadSummary || "";
      }

      // For post-meeting follow-ups
      if (taskType === "post_meeting_followup_email") {
        payload.meeting_summary_brief = "Recent meeting with lead - follow up on discussed items.";
      }

      const result = await runTask(taskType, payload);

      if (result.ok && result.content) {
        setBody(result.content);
        setKnowledgeUsed(!!(result as any).knowledge_context_used);
        
        // Generate subject based on action type
        const actionType = getActionType(lead.next_action_key);
        if (actionType === "reply" && emails[0]?.subject) {
          setSubject(`Re: ${emails[0].subject.replace(/^Re:\s*/i, '')}`);
        } else if (actionType === "recap") {
          setSubject(`Following up on our conversation - ${lead.company}`);
        } else {
          setSubject(`Quick note - ${lead.company}`);
        }
      } else {
        toast.error("Failed to generate email");
      }
    } catch (err) {
      console.error("Error generating email:", err);
      toast.error("Failed to generate email");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleSend() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    const result = await sendEmail(to.trim(), subject.trim(), body.trim(), lead.id);
    if (result.ok) {
      onOpenChange(false);
      toast.success("Email sent successfully!");
    }
  }

  const actionType = getActionType(lead.next_action_key);
  const dialogTitle = actionType === "reply" 
    ? `Reply to ${lead.name}` 
    : actionType === "recap"
    ? `Post-Meeting Follow-up for ${lead.name}`
    : `Email to ${lead.name}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            {dialogTitle}
          </DialogTitle>
          <DialogDescription>
            {lead.next_action_label || "Prepare and send an email"}
          </DialogDescription>
        </DialogHeader>

        {/* Thread Context Collapsible */}
        {threadContext.length > 0 && (
          <Collapsible open={showThread} onOpenChange={setShowThread}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground">
                {showThread ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {threadContext.length} previous email{threadContext.length > 1 ? 's' : ''} in thread
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <div className="bg-muted/50 rounded-lg p-3 space-y-2 text-sm max-h-[150px] overflow-y-auto">
                {threadContext.map((email, idx) => (
                  <div key={idx} className="text-muted-foreground whitespace-pre-wrap border-l-2 border-muted-foreground/20 pl-2">
                    {email}
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Email Form */}
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="to">To</Label>
            <Input
              id="to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={isGenerating ? "Generating..." : "Email subject"}
              disabled={isGenerating}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="body">Message</Label>
            {isGenerating ? (
              <div className="flex items-center justify-center h-[200px] border rounded-md bg-muted/20">
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="text-sm">Generating email...</span>
                </div>
              </div>
            ) : (
              <Textarea
                id="body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Email body"
                className="min-h-[200px]"
              />
            )}
          </div>

          {/* Indicators */}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="ghost"
              size="sm"
              onClick={generateEmail}
              disabled={isGenerating}
              className="gap-1"
            >
              <RefreshCw className={`h-4 w-4 ${isGenerating ? 'animate-spin' : ''}`} />
              Regenerate
            </Button>
            {knowledgeUsed && (
              <Badge variant="secondary" className="gap-1">
                <BookOpen className="h-3 w-3" />
                Knowledge Base Used
              </Badge>
            )}
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" asChild className="gap-1">
            <Link to={`/dashboard/leads/${lead.id}`}>
              <ExternalLink className="h-4 w-4" />
              View Lead
            </Link>
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {isConnected ? (
            <Button 
              onClick={handleSend} 
              disabled={isSyncing || isGenerating || !body.trim()}
              className="gap-1"
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send via Gmail
            </Button>
          ) : (
            <Button disabled className="gap-1">
              <Send className="h-4 w-4" />
              Connect Gmail to Send
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
