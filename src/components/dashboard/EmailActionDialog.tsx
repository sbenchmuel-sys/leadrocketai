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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Loader2, 
  Send, 
  ExternalLink, 
  RefreshCw, 
  ChevronDown,
  ChevronRight,
  BookOpen,
  Mail,
  Paperclip,
  Lightbulb,
  PenLine
} from "lucide-react";
import { useAITask, AITaskType } from "@/hooks/useAITask";
import { useGmailSync } from "@/hooks/useGmailSync";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { getLeadEmailThread, getLeadDetail, saveDraft } from "@/lib/supabaseQueries";
import { getSignatures, getDefaultSignature, getKnowledgeDocuments, RepSignature, KnowledgeDocument, getRepProfile } from "@/lib/repProfileQueries";
import { toast } from "sonner";
import { EnrichedLead, getActionType } from "@/lib/dashboardUtils";

// Minimal lead interface for this dialog (compatible with both EnrichedLead and LeadDetail)
interface MinimalLead {
  id: string;
  name: string;
  company: string;
  email: string;
  stage: string;
  strategy?: string;
  job_title?: string | null;
  industry?: string | null;
  personal_notes?: string | null;
  meeting_link?: string | null;
  next_action_key?: string | null;
  next_action_label?: string | null;
}

interface EmailActionDialogProps {
  lead: MinimalLead;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss?: () => void;
  onSuccess?: () => void;
  initialInstructions?: string;
  prefilledSubject?: string;
  prefilledBody?: string;
  actionKey?: string;
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

// Build Gmail compose URL
function buildGmailComposeUrl(to: string, subject: string, body: string): string {
  const params = new URLSearchParams();
  params.set("to", to);
  params.set("su", subject);
  params.set("body", body);
  return `https://mail.google.com/mail/?view=cm&fs=1&${params.toString()}`;
}

export function EmailActionDialog({
  lead,
  open,
  onOpenChange,
  onDismiss,
  onSuccess,
  initialInstructions = "",
  prefilledSubject,
  prefilledBody,
  actionKey,
}: EmailActionDialogProps) {
  const [to, setTo] = useState(lead.email);
  const [subject, setSubject] = useState(prefilledSubject || "");
  const [body, setBody] = useState(prefilledBody || "");
  const [instructions, setInstructions] = useState(initialInstructions);
  const [isGenerating, setIsGenerating] = useState(false);
  const [threadContext, setThreadContext] = useState<string[]>([]);
  const [showThread, setShowThread] = useState(false);
  const [knowledgeUsed, setKnowledgeUsed] = useState(false);
  
  // Signature state
  const [signatures, setSignatures] = useState<RepSignature[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string>("");
  const [signatureText, setSignatureText] = useState("");
  
  // Attachments state
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDocument[]>([]);
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>([]);
  
  const { runTask } = useAITask();
  const { sendEmail, isSyncing } = useGmailSync();
  const { isConnected } = useGmailConnection();

  // Load signatures and knowledge docs on mount
  useEffect(() => {
    loadSignaturesAndDocs();
  }, []);

  // Generate email when dialog opens (skip if prefilled)
  useEffect(() => {
    if (open) {
      setTo(lead.email);
      setInstructions(initialInstructions);
      
      // If prefilled values provided, use them instead of generating
      if (prefilledSubject || prefilledBody) {
        setSubject(prefilledSubject || "");
        setBody(prefilledBody || "");
      } else {
        generateEmail();
      }
    }
  }, [open, lead.id]);

  async function loadSignaturesAndDocs() {
    try {
      const [sigs, docs] = await Promise.all([
        getSignatures(),
        getKnowledgeDocuments(),
      ]);
      setSignatures(sigs);
      setKnowledgeDocs(docs);
      
      // Set default signature
      const defaultSig = sigs.find(s => s.is_default);
      if (defaultSig) {
        setSelectedSignatureId(defaultSig.id);
        setSignatureText(defaultSig.signature_text);
      } else if (sigs.length > 0) {
        setSelectedSignatureId(sigs[0].id);
        setSignatureText(sigs[0].signature_text);
      }
    } catch (err) {
      console.error("Failed to load signatures/docs:", err);
    }
  }

  function handleSignatureChange(sigId: string) {
    setSelectedSignatureId(sigId);
    const sig = signatures.find(s => s.id === sigId);
    if (sig) {
      setSignatureText(sig.signature_text);
    }
  }

  function toggleAttachment(docId: string) {
    setSelectedAttachments(prev => 
      prev.includes(docId) 
        ? prev.filter(id => id !== docId)
        : [...prev, docId]
    );
  }

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
      // Use actionKey prop if provided, otherwise fall back to lead.next_action_key
      const effectiveActionKey = actionKey || lead.next_action_key || null;
      const taskType = getAITaskForAction(effectiveActionKey, hasThread);
      
      // Get full lead details and rep profile for better context
      let leadDetail;
      try {
        leadDetail = await getLeadDetail(lead.id);
      } catch {
        leadDetail = lead;
      }

      // Get rep profile for personalization
      let repProfile;
      try {
        repProfile = await getRepProfile();
      } catch {
        repProfile = null;
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

      // Build rep context
      const repContext = repProfile ? `
Sender Name: ${repProfile.full_name || 'Sales Rep'}
Sender Title: ${repProfile.job_title || ''}
Sender Company: ${repProfile.company_name || ''}
Calendar Link: ${repProfile.calendar_link || ''}
`.trim() : '';

      // Prepare payload based on task type
      const payload: Record<string, unknown> = {
        lead_id: lead.id,
        lead_context: leadContext,
        rep_context: repContext,
        meeting_link: leadDetail.meeting_link || repProfile?.calendar_link || '',
        custom_instructions: instructions.trim() || undefined,
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

  // Get full email body with signature
  function getFullEmailBody(): string {
    if (signatureText) {
      return `${body}\n\n${signatureText}`;
    }
    return body;
  }

  async function handleSend() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    const fullBody = getFullEmailBody();
    const result = await sendEmail(to.trim(), subject.trim(), fullBody, lead.id);
    if (result.ok) {
      onOpenChange(false);
      toast.success("Email sent successfully!");
      onSuccess?.();
    }
  }

  async function handleOpenInGmail() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error("Please fill in all fields first");
      return;
    }

    // Save as draft before opening Gmail
    try {
      await saveDraft(lead.id, {
        channel: 'email',
        draft_type: 'gmail_compose',
        to_recipient: to.trim(),
        subject: subject.trim(),
        body_text: getFullEmailBody(),
        status: 'pending',
      });
    } catch (err) {
      console.error("Failed to save draft:", err);
      // Continue anyway - not critical
    }

    // Build Gmail compose URL
    const fullBody = getFullEmailBody();
    
    // Add attachment reminder if any selected
    let bodyWithAttachments = fullBody;
    if (selectedAttachments.length > 0) {
      const attachmentNames = selectedAttachments
        .map(id => knowledgeDocs.find(d => d.id === id)?.title || 'Document')
        .join(', ');
      bodyWithAttachments += `\n\n---\n[Remember to attach: ${attachmentNames}]`;
    }

    const gmailUrl = buildGmailComposeUrl(to.trim(), subject.trim(), bodyWithAttachments);
    window.open(gmailUrl, '_blank');
    
    toast.success("Opening Gmail compose...");
    onOpenChange(false);
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
            <Mail className="h-5 w-5" />
            {dialogTitle}
          </DialogTitle>
          <DialogDescription>
            {lead.next_action_label || "Prepare and send an email"}
          </DialogDescription>
        </DialogHeader>

        {/* Instructions Input */}
        <div className="space-y-2">
          <Label htmlFor="instructions" className="flex items-center gap-2 text-sm">
            <Lightbulb className="h-4 w-4 text-amber-500" />
            Instructions (optional)
          </Label>
          <div className="flex gap-2">
            <Input
              id="instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g., Mention the conference we met at..."
              className="flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={generateEmail}
              disabled={isGenerating}
              className="gap-1 shrink-0"
            >
              <RefreshCw className={`h-4 w-4 ${isGenerating ? 'animate-spin' : ''}`} />
              {instructions ? 'Regenerate' : 'Generate'}
            </Button>
          </div>
        </div>

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
        <div className="space-y-4">
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
                className="min-h-[180px]"
              />
            )}
          </div>

          {/* Signature Selector */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <PenLine className="h-4 w-4" />
                Signature
              </Label>
              <Select value={selectedSignatureId} onValueChange={handleSignatureChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select signature" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No signature</SelectItem>
                  {signatures.map(sig => (
                    <SelectItem key={sig.id} value={sig.id}>
                      {sig.name} {sig.is_default && "(default)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Attachments Selector */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Paperclip className="h-4 w-4" />
                Suggest Attachments
              </Label>
              <Select 
                value={selectedAttachments.length > 0 ? "selected" : ""} 
                onValueChange={() => {}}
              >
                <SelectTrigger>
                  <SelectValue placeholder={
                    selectedAttachments.length > 0 
                      ? `${selectedAttachments.length} selected` 
                      : "Select documents"
                  } />
                </SelectTrigger>
                <SelectContent>
                  {knowledgeDocs.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">
                      No documents in knowledge base
                    </div>
                  ) : (
                    knowledgeDocs.slice(0, 10).map(doc => (
                      <div
                        key={doc.id}
                        className="flex items-center gap-2 p-2 hover:bg-muted cursor-pointer"
                        onClick={() => toggleAttachment(doc.id)}
                      >
                        <input
                          type="checkbox"
                          checked={selectedAttachments.includes(doc.id)}
                          onChange={() => {}}
                          className="h-4 w-4"
                        />
                        <span className="text-sm truncate">
                          {doc.title || doc.source || 'Untitled Document'}
                        </span>
                      </div>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Signature Preview */}
          {signatureText && (
            <div className="p-3 bg-muted/30 rounded-lg border">
              <p className="text-xs text-muted-foreground mb-1">Signature preview:</p>
              <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground">
                {signatureText}
              </pre>
            </div>
          )}

          {/* Indicators */}
          <div className="flex items-center gap-2 flex-wrap">
            {knowledgeUsed && (
              <Badge variant="secondary" className="gap-1">
                <BookOpen className="h-3 w-3" />
                Knowledge Base Used
              </Badge>
            )}
            {selectedAttachments.length > 0 && (
              <Badge variant="outline" className="gap-1">
                <Paperclip className="h-3 w-3" />
                {selectedAttachments.length} attachment{selectedAttachments.length > 1 ? 's' : ''} to add
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
          
          {/* Primary action: Open in Gmail */}
          <Button 
            onClick={handleOpenInGmail}
            disabled={isGenerating || !body.trim()}
            className="gap-1"
            variant="default"
          >
            <Mail className="h-4 w-4" />
            Open in Gmail
          </Button>
          
          {/* Secondary: Direct send if connected */}
          {isConnected && (
            <Button 
              onClick={handleSend} 
              disabled={isSyncing || isGenerating || !body.trim()}
              className="gap-1"
              variant="secondary"
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send Now
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
