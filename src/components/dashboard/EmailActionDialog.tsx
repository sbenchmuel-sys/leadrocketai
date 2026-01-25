import { useState, useEffect, useCallback, useRef } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
  PenLine,
  Wand2,
  Scissors,
  Sparkles,
  Calendar,
  MessageSquare,
  Undo2
} from "lucide-react";
import { useAITask, AITaskType } from "@/hooks/useAITask";
import { useGmailSync } from "@/hooks/useGmailSync";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { getLeadEmailThread, getLeadDetail, saveDraft, dismissLeadAction, EmailThreadItem } from "@/lib/supabaseQueries";
import { updateMeetingPackFollowup, getSignatures, getDefaultSignature, getKnowledgeDocuments, RepSignature, KnowledgeDocument, getRepProfile, RepProfile } from "@/lib/repProfileQueries";
import { getWorkspaceProfile, formatWorkspaceContext, WorkspaceProfile } from "@/lib/workspaceProfileQueries";
import { toast } from "sonner";
import { EnrichedLead, getActionType } from "@/lib/dashboardUtils";

// Minimal lead interface for this dialog
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
  initial_message?: string | null;
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

// Get display mode: reply or new_outreach
function getEmailMode(actionKey: string | null, hasThread: boolean): 'reply' | 'new_outreach' {
  const actionType = getActionType(actionKey);
  return (actionType === "reply" && hasThread) ? 'reply' : 'new_outreach';
}

// Build Gmail compose URL
function buildGmailComposeUrl(to: string, subject: string, body: string, fromEmail?: string): string {
  const params = new URLSearchParams();
  params.set("to", to);
  params.set("su", subject);
  params.set("body", body);
  
  if (fromEmail) {
    params.set("authuser", fromEmail);
    const encodedEmail = encodeURIComponent(fromEmail);
    return `https://mail.google.com/mail/u/${encodedEmail}/?view=cm&fs=1&${params.toString()}`;
  }
  
  return `https://mail.google.com/mail/?view=cm&fs=1&${params.toString()}`;
}

// One-click action button component
interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}

function ActionButton({ icon, label, onClick, loading, disabled }: ActionButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={loading || disabled}
      className="gap-1.5 h-8 text-xs"
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {label}
    </Button>
  );
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
  const [knowledgeUsed, setKnowledgeUsed] = useState(false);
  
  // Thread state - now stores full email objects
  const [threadEmails, setThreadEmails] = useState<EmailThreadItem[]>([]);
  const [showOlderEmails, setShowOlderEmails] = useState(false);
  
  // Threading state for in-thread replies
  const [replyThreadId, setReplyThreadId] = useState<string | null>(null);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  
  // Signature state
  const [signatures, setSignatures] = useState<RepSignature[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string>("");
  const [signatureText, setSignatureText] = useState("");
  const [showSignature, setShowSignature] = useState(false);
  
  // Attachments state
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDocument[]>([]);
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>([]);
  
  // Profile state
  const [repProfile, setRepProfile] = useState<RepProfile | null>(null);
  const [workspaceProfile, setWorkspaceProfile] = useState<WorkspaceProfile | null>(null);
  
  // Undo state
  const [previousBody, setPreviousBody] = useState<string | null>(null);
  const [previousSubject, setPreviousSubject] = useState<string | null>(null);
  const [showUndo, setShowUndo] = useState(false);
  
  // One-click action loading states
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  
  const { runTask } = useAITask();
  const { sendEmail, isSyncing } = useGmailSync();
  const { isConnected, connection } = useGmailConnection();

  // Load signatures, docs, and profiles on mount
  useEffect(() => {
    loadData();
  }, []);

  // Generate email when dialog opens
  useEffect(() => {
    if (open) {
      setTo(lead.email);
      setInstructions(initialInstructions);
      
      if (prefilledSubject || prefilledBody) {
        setSubject(prefilledSubject || "");
        setBody(prefilledBody || "");
      } else {
        generateEmail();
      }
    }
  }, [open, lead.id]);

  async function loadData() {
    try {
      const [sigs, docs, rep, workspace] = await Promise.all([
        getSignatures(),
        getKnowledgeDocuments(),
        getRepProfile().catch(() => null),
        getWorkspaceProfile().catch(() => null),
      ]);
      
      setSignatures(sigs);
      setKnowledgeDocs(docs);
      setRepProfile(rep);
      setWorkspaceProfile(workspace);
      
      // Set default signature
      const defaultSig = sigs.find(s => s.is_default);
      if (defaultSig) {
        setSelectedSignatureId(defaultSig.id);
        setSignatureText(defaultSig.signature_text);
      } else if (sigs.length > 0) {
        setSelectedSignatureId(sigs[0].id);
        setSignatureText(sigs[0].signature_text);
      } else {
        setSelectedSignatureId("none");
        setSignatureText("");
      }
    } catch (err) {
      console.error("Failed to load data:", err);
    }
  }

  function handleSignatureChange(sigId: string) {
    setSelectedSignatureId(sigId);
    if (sigId === "none") {
      setSignatureText("");
    } else {
      const sig = signatures.find(s => s.id === sigId);
      if (sig) setSignatureText(sig.signature_text);
    }
  }

  function toggleAttachment(docId: string) {
    setSelectedAttachments(prev => 
      prev.includes(docId) ? prev.filter(id => id !== docId) : [...prev, docId]
    );
  }

  // Build context for AI
  function buildLeadContext(): string {
    return `
Name: ${lead.name}
Company: ${lead.company}
Email: ${lead.email}
Strategy: ${lead.strategy || 'not set'}
Stage: ${lead.stage}
${lead.job_title ? `Title: ${lead.job_title}` : ''}
${lead.industry ? `Industry: ${lead.industry}` : ''}
${lead.personal_notes ? `Notes: ${lead.personal_notes}` : ''}
`.trim();
  }

  function buildRepContext(): string {
    if (!repProfile) return '';
    return `
Sender Name: ${repProfile.full_name || 'Sales Rep'}
Sender Title: ${repProfile.job_title || ''}
Sender Company: ${repProfile.company_name || workspaceProfile?.company_name || ''}
Calendar Link: ${repProfile.calendar_link || ''}
`.trim();
  }

  async function generateEmail() {
    setIsGenerating(true);
    setBody("");
    setSubject("");
    setKnowledgeUsed(false);
    setReplyThreadId(null);
    setReplyToMessageId(null);

    try {
      // Fetch full email thread
      const { emails, threadSummary } = await getLeadEmailThread(lead.id, 10);
      setThreadEmails(emails);
      
      // Extract threading info from the most recent inbound email
      const latestInbound = emails.find(e => e.direction === 'inbound');
      if (latestInbound) {
        setReplyThreadId(latestInbound.gmail_thread_id);
        setReplyToMessageId(latestInbound.gmail_message_id);
      }

      const hasThread = emails.length > 0;
      const effectiveActionKey = actionKey || lead.next_action_key || null;
      const taskType = getAITaskForAction(effectiveActionKey, hasThread);
      
      // Get lead details
      let leadDetail;
      try {
        leadDetail = await getLeadDetail(lead.id);
      } catch {
        leadDetail = lead;
      }

      const leadContext = buildLeadContext();
      const repContext = buildRepContext();
      const workspaceContext = formatWorkspaceContext(workspaceProfile);

      // Prepare payload based on task type
      const payload: Record<string, unknown> = {
        lead_id: lead.id,
        lead_context: leadContext,
        rep_context: repContext,
        workspace_context: workspaceContext,
        meeting_link: leadDetail.meeting_link || repProfile?.calendar_link || '',
        custom_instructions: instructions.trim() || undefined,
      };

      // Add thread context for replies
      if (hasThread && taskType === "reply_to_thread") {
        payload.email_thread = threadSummary;
        payload.latest_inbound = latestInbound?.body_text || '';
      }

      // Add lead card context for new outreach
      if (!hasThread && lead.initial_message) {
        payload.lead_card_message = lead.initial_message;
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
        
        // Generate subject
        const actionType = getActionType(effectiveActionKey);
        const leadFirstName = lead.name.split(' ')[0];
        const companyName = lead.company && lead.company !== 'Unknown Company' ? lead.company : null;
        
        if (actionType === "reply" && emails[0]?.subject) {
          setSubject(`Re: ${emails[0].subject.replace(/^Re:\s*/i, '')}`);
        } else if (actionType === "recap") {
          setSubject(`Following up on our conversation${companyName ? ` - ${companyName}` : ''}`);
        } else if (actionType === "follow_up" && effectiveActionKey?.includes("pre_2")) {
          setSubject(`Following up - ${leadFirstName}`);
        } else if (actionType === "follow_up" && effectiveActionKey?.includes("pre_3")) {
          setSubject(`Checking in - ${leadFirstName}`);
        } else if (actionType === "follow_up" && effectiveActionKey?.includes("pre_4")) {
          setSubject(`Closing the loop - ${leadFirstName}`);
        } else if (actionType === "nurture") {
          setSubject(`Thought you'd find this valuable${companyName ? `, ${leadFirstName}` : ''}`);
        } else {
          setSubject(companyName 
            ? `Introduction - ${companyName}` 
            : `Connecting with you, ${leadFirstName}`
          );
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

  // ========== ONE-CLICK ACTIONS ==========
  
  async function runOneClickAction(
    taskType: AITaskType, 
    actionName: string,
    extraPayload?: Record<string, unknown>
  ) {
    if (!body.trim()) {
      toast.error("Generate an email first");
      return;
    }
    
    // Save current state for undo
    setPreviousBody(body);
    setPreviousSubject(subject);
    setActionLoading(actionName);
    
    try {
      const payload: Record<string, unknown> = {
        draft_text: body,
        draft_body: body,
        lead_context: buildLeadContext(),
        rep_context: buildRepContext(),
        workspace_context: formatWorkspaceContext(workspaceProfile),
        lead_id: lead.id,
        ...extraPayload,
      };
      
      const result = await runTask(taskType, payload);
      
      if (result.ok && result.content) {
        setBody(result.content);
        setShowUndo(true);
        toast.success(`${actionName} applied`, {
          action: {
            label: "Undo",
            onClick: handleUndo,
          },
        });
        
        // Auto-hide undo after 10 seconds
        setTimeout(() => setShowUndo(false), 10000);
      } else {
        toast.error(`Failed to ${actionName.toLowerCase()}`);
      }
    } catch (err) {
      console.error(`Error in ${actionName}:`, err);
      toast.error(`Failed to ${actionName.toLowerCase()}`);
    } finally {
      setActionLoading(null);
    }
  }
  
  function handleUndo() {
    if (previousBody !== null) {
      setBody(previousBody);
      setPreviousBody(null);
    }
    if (previousSubject !== null) {
      setSubject(previousSubject);
      setPreviousSubject(null);
    }
    setShowUndo(false);
    toast.success("Undone");
  }

  // Action handlers
  const handleFixGrammar = () => runOneClickAction("shorten_draft", "Fix grammar", { target: "fix_grammar" });
  const handleShorten = () => runOneClickAction("shorten_draft", "Shorten", { target: "shorten_30" });
  const handleAddMeetingCTA = () => runOneClickAction("shorten_draft", "Add CTA", { 
    target: "add_meeting_cta",
    meeting_link: repProfile?.calendar_link || '',
    timezone: workspaceProfile?.meeting_timezone || '',
  });
  const handleAnswerWithKB = () => runOneClickAction("answer_questions", "Answer with KB", {
    questions_list: "Answer any questions in the email thread using the knowledge base",
    email_thread: threadEmails.map(e => `[${e.direction}] ${e.subject || ''}\n${e.body_text}`).join('\n---\n'),
  });

  // Get full email body with signature
  function getFullEmailBody(): string {
    if (signatureText) return `${body}\n\n${signatureText}`;
    return body;
  }

  async function handleSend() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    const fullBody = getFullEmailBody();
    const result = await sendEmail(
      to.trim(), 
      subject.trim(), 
      fullBody, 
      lead.id, 
      undefined,
      replyThreadId || undefined,
      replyToMessageId || undefined
    );
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

    const fullBody = getFullEmailBody();
    const effectiveActionKey = actionKey || lead.next_action_key || null;
    const currentActionType = getActionType(effectiveActionKey);

    // Save as draft
    try {
      await saveDraft(lead.id, {
        channel: 'email',
        draft_type: 'gmail_compose',
        to_recipient: to.trim(),
        subject: subject.trim(),
        body_text: fullBody,
        status: 'pending',
      });
    } catch (err) {
      console.error("Failed to save draft:", err);
    }

    // Handle post-meeting recap
    if (currentActionType === "recap") {
      try {
        await updateMeetingPackFollowup(lead.id, subject.trim(), fullBody);
        await dismissLeadAction(lead.id);
      } catch (err) {
        console.error("Failed to update meeting pack followup:", err);
      }
    }
    
    // Add attachment reminder
    let bodyWithAttachments = fullBody;
    if (selectedAttachments.length > 0) {
      const attachmentNames = selectedAttachments
        .map(id => knowledgeDocs.find(d => d.id === id)?.title || 'Document')
        .join(', ');
      bodyWithAttachments += `\n\n---\n[Remember to attach: ${attachmentNames}]`;
    }

    const gmailUrl = buildGmailComposeUrl(to.trim(), subject.trim(), bodyWithAttachments, connection?.gmail_email);
    window.open(gmailUrl, '_blank');
    
    toast.success("Opening Gmail compose...");
    onOpenChange(false);
    onSuccess?.();
  }

  // Determine email mode and dialog title
  const effectiveActionKey = actionKey || lead.next_action_key || null;
  const hasThread = threadEmails.length > 0;
  const emailMode = getEmailMode(effectiveActionKey, hasThread);
  const latestInbound = threadEmails.find(e => e.direction === 'inbound');
  const olderEmails = threadEmails.slice(latestInbound ? 1 : 0);
  
  const actionType = getActionType(lead.next_action_key);
  const dialogTitle = actionType === "reply" 
    ? `Reply to ${lead.name}` 
    : actionType === "recap"
    ? `Post-Meeting Follow-up for ${lead.name}`
    : `Email to ${lead.name}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[95vh] flex flex-col p-0 gap-0">
        {/* Sticky Header */}
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              {dialogTitle}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {lead.next_action_label || "Prepare and send an email"}
          </DialogDescription>
          
          {/* To and Subject fields in header */}
          <div className="grid gap-3 pt-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="to" className="w-16 text-right text-sm">To:</Label>
              <Input
                id="to"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="recipient@example.com"
                className="flex-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="subject" className="w-16 text-right text-sm">Subject:</Label>
              <Input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={isGenerating ? "Generating..." : "Email subject"}
                disabled={isGenerating}
                className="flex-1"
              />
            </div>
          </div>
        </DialogHeader>

        {/* Scrollable Content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-4 space-y-4">
            {/* Instructions Input */}
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Lightbulb className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-amber-500" />
                <Input
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Add instructions (e.g., mention the conference we met at...)"
                  className="pl-10"
                />
              </div>
              <Button
                variant="outline"
                onClick={generateEmail}
                disabled={isGenerating}
                className="gap-1 shrink-0"
              >
                <RefreshCw className={`h-4 w-4 ${isGenerating ? 'animate-spin' : ''}`} />
                {body ? 'Regenerate' : 'Generate'}
              </Button>
            </div>

            {/* One-Click Action Bar */}
            <div className="flex flex-wrap gap-2 p-3 bg-muted/30 rounded-lg border">
              <ActionButton
                icon={<Wand2 className="h-3.5 w-3.5" />}
                label="Fix grammar"
                onClick={handleFixGrammar}
                loading={actionLoading === "Fix grammar"}
                disabled={isGenerating || !body}
              />
              <ActionButton
                icon={<Scissors className="h-3.5 w-3.5" />}
                label="Shorten"
                onClick={handleShorten}
                loading={actionLoading === "Shorten"}
                disabled={isGenerating || !body}
              />
              <ActionButton
                icon={<BookOpen className="h-3.5 w-3.5" />}
                label="Answer with KB"
                onClick={handleAnswerWithKB}
                loading={actionLoading === "Answer with KB"}
                disabled={isGenerating || !body}
              />
              <ActionButton
                icon={<Calendar className="h-3.5 w-3.5" />}
                label="Add meeting CTA"
                onClick={handleAddMeetingCTA}
                loading={actionLoading === "Add CTA"}
                disabled={isGenerating || !body}
              />
              {showUndo && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleUndo}
                  className="gap-1.5 h-8 text-xs ml-auto"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Undo
                </Button>
              )}
            </div>

            {/* Email Body Editor */}
            <div className="space-y-2">
              <Label htmlFor="body" className="sr-only">Message</Label>
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
                  className="min-h-[200px] text-base leading-relaxed"
                />
              )}
            </div>

            {/* Signature Section */}
            <Collapsible open={showSignature} onOpenChange={setShowSignature}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground">
                  <PenLine className="h-4 w-4" />
                  Signature: {signatures.find(s => s.id === selectedSignatureId)?.name || "None"}
                  {showSignature ? <ChevronDown className="h-4 w-4 ml-auto" /> : <ChevronRight className="h-4 w-4 ml-auto" />}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <div className="space-y-3 p-3 bg-muted/30 rounded-lg">
                  <Select value={selectedSignatureId} onValueChange={handleSignatureChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select signature" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No signature</SelectItem>
                      {signatures.map(sig => (
                        <SelectItem key={sig.id} value={sig.id}>
                          {sig.name} {sig.is_default && "(default)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {signatureText && (
                    <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground p-2 bg-background rounded border">
                      {signatureText}
                    </pre>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>

            <Separator />

            {/* Context Panel - Mode Aware */}
            {emailMode === 'reply' && latestInbound ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <MessageSquare className="h-4 w-4" />
                  Latest from {lead.name}
                </div>
                
                {/* Latest Inbound - Always expanded, never truncated */}
                <div className="p-4 bg-muted/50 rounded-lg border">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                    <span>From: {latestInbound.from_email}</span>
                    <span>•</span>
                    <span>{new Date(latestInbound.occurred_at).toLocaleDateString()}</span>
                  </div>
                  {latestInbound.subject && (
                    <div className="font-medium text-sm mb-2">
                      {latestInbound.subject}
                    </div>
                  )}
                  {/* FULL email body - never truncated */}
                  <div className="text-sm whitespace-pre-wrap">
                    {latestInbound.body_text}
                  </div>
                </div>

                {/* Older Emails - Collapsed */}
                {olderEmails.length > 0 && (
                  <Collapsible open={showOlderEmails} onOpenChange={setShowOlderEmails}>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground">
                        {showOlderEmails ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {olderEmails.length} older email{olderEmails.length > 1 ? 's' : ''} in thread
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-2 pt-2">
                      {olderEmails.map((email, idx) => (
                        <div key={email.id || idx} className="p-3 bg-muted/30 rounded-lg text-sm">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                            <span>{email.direction === 'inbound' ? 'From' : 'To'}: {email.from_email}</span>
                            <span>•</span>
                            <span>{new Date(email.occurred_at).toLocaleDateString()}</span>
                          </div>
                          {email.subject && <div className="font-medium mb-1">{email.subject}</div>}
                          <div className="text-muted-foreground whitespace-pre-wrap">
                            {email.body_text}
                          </div>
                        </div>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            ) : (
              /* New Outreach Mode - Show Lead Context */
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="h-4 w-4" />
                  Lead Context
                </div>
                <div className="p-4 bg-muted/50 rounded-lg border">
                  <div className="grid gap-2 text-sm">
                    <div><span className="text-muted-foreground">Name:</span> {lead.name}</div>
                    <div><span className="text-muted-foreground">Company:</span> {lead.company}</div>
                    {lead.job_title && <div><span className="text-muted-foreground">Title:</span> {lead.job_title}</div>}
                    {lead.industry && <div><span className="text-muted-foreground">Industry:</span> {lead.industry}</div>}
                    {lead.personal_notes && (
                      <div className="mt-2 pt-2 border-t">
                        <span className="text-muted-foreground">Notes:</span>
                        <p className="mt-1">{lead.personal_notes}</p>
                      </div>
                    )}
                    {lead.initial_message && (
                      <div className="mt-2 pt-2 border-t">
                        <span className="text-muted-foreground">Initial Message:</span>
                        <p className="mt-1 whitespace-pre-wrap">{lead.initial_message}</p>
                      </div>
                    )}
                  </div>
                </div>
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
              {replyThreadId && (
                <Badge variant="outline" className="gap-1">
                  <MessageSquare className="h-3 w-3" />
                  In-thread reply
                </Badge>
              )}
              {selectedAttachments.length > 0 && (
                <Badge variant="outline" className="gap-1">
                  <Paperclip className="h-3 w-3" />
                  {selectedAttachments.length} attachment{selectedAttachments.length > 1 ? 's' : ''}
                </Badge>
              )}
            </div>
          </div>
        </ScrollArea>

        {/* Sticky Footer */}
        <DialogFooter className="px-6 py-4 border-t shrink-0 flex-row gap-2 sm:justify-between">
          <div className="flex items-center gap-2">
            {/* Attachments selector */}
            <Select 
              value={selectedAttachments.length > 0 ? "selected" : ""} 
              onValueChange={() => {}}
            >
              <SelectTrigger className="w-auto gap-2">
                <Paperclip className="h-4 w-4" />
                <span className="hidden sm:inline">
                  {selectedAttachments.length > 0 
                    ? `${selectedAttachments.length} file${selectedAttachments.length > 1 ? 's' : ''}` 
                    : "Attach"}
                </span>
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
            
            <Button variant="outline" asChild className="gap-1">
              <Link to={`/dashboard/leads/${lead.id}`}>
                <ExternalLink className="h-4 w-4" />
                <span className="hidden sm:inline">View Lead</span>
              </Link>
            </Button>
          </div>
          
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            
            <Button 
              onClick={handleOpenInGmail}
              disabled={isGenerating || !body.trim()}
              variant="outline"
              className="gap-1"
            >
              <Mail className="h-4 w-4" />
              <span className="hidden sm:inline">Open in Gmail</span>
            </Button>
            
            {isConnected && (
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
                Send
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
