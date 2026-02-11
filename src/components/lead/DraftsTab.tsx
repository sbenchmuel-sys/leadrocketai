import { useEffect, useState, useMemo } from "react";
import { LeadDetail, getLeadDrafts, saveDraft, getLeadInteractions, getLeadMeetingPacks, updateDraftStatus, createMeetingPack, appendLeadMilestones, MilestoneItem } from "@/lib/supabaseQueries";
import { useAITask, AITaskType } from "@/hooks/useAITask";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Copy, Save, Mail, Linkedin, MessageSquare, Loader2, Sparkles, Send, Edit2, CheckCircle2, ChevronDown, ChevronUp, AlertCircle, RefreshCw, Database } from "lucide-react";
import { format, differenceInDays } from "date-fns";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SendEmailButton } from "@/components/gmail/SendEmailButton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmailActionDialog } from "@/components/dashboard/EmailActionDialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { generateDraft } from "@/lib/generateDraft";

// ============================================
// Types
// ============================================

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
  step_key?: string | null;
  nurture_theme?: string | null;
  nurture_cadence?: string | null;
}

type Channel = "email" | "whatsapp" | "linkedin";

type EmailIntent =
  | "follow_up"
  | "inbound_response"
  | "reply_to_thread"
  | "post_meeting_recap"
  | "closing_nudge"
  | "nurture_email";

type LinkedInIntent = "connection_request" | "follow_up_message";
type WhatsAppIntent = "quick_follow_up" | "meeting_reminder" | "short_answer";

type ComposerIntent = EmailIntent | LinkedInIntent | WhatsAppIntent;

const EMAIL_INTENT_LABELS: Record<EmailIntent, string> = {
  follow_up: "Follow-up",
  inbound_response: "Inbound Response",
  reply_to_thread: "Reply to Thread",
  post_meeting_recap: "Post-Meeting Recap",
  closing_nudge: "Closing Nudge",
  nurture_email: "Nurture Email",
};

const LINKEDIN_INTENT_LABELS: Record<LinkedInIntent, string> = {
  connection_request: "Connection Request",
  follow_up_message: "Follow-up Message",
};

const WHATSAPP_INTENT_LABELS: Record<WhatsAppIntent, string> = {
  quick_follow_up: "Quick Follow-up",
  meeting_reminder: "Meeting Reminder",
  short_answer: "Short Answer",
};

const CHAR_LIMITS: Partial<Record<ComposerIntent, number>> = {
  connection_request: 300,
  follow_up_message: 600,
  quick_follow_up: 500,
  meeting_reminder: 300,
  short_answer: 400,
};

// Map composer intents to AITaskType for pipeline override
const INTENT_TO_AI_TASK: Partial<Record<ComposerIntent, AITaskType>> = {
  follow_up: "pre_email_2_followup",
  inbound_response: "pre_email_1_intro",
  reply_to_thread: "reply_to_thread",
  post_meeting_recap: "post_meeting_followup_email",
  closing_nudge: "pre_email_3_followup",
  nurture_email: "nurture_email_single",
  connection_request: "linkedin_connect",
  follow_up_message: "linkedin_followup",
  quick_follow_up: "pre_email_2_followup",
  meeting_reminder: "pre_email_2_followup",
  short_answer: "answer_questions",
};

// Map email intents to EmailActionDialog action keys
const EMAIL_INTENT_TO_ACTION_KEY: Record<EmailIntent, string> = {
  follow_up: "send_pre_2_followup",
  inbound_response: "reply_now",
  reply_to_thread: "reply_now",
  post_meeting_recap: "generate_post_meeting_recap",
  closing_nudge: "send_pre_3_followup",
  nurture_email: "send_nurture_1",
};

// Auto-Intent Logic
// ============================================

interface IntentSuggestion {
  intent: ComposerIntent;
  reason: string;
}

function deriveEmailIntent(lead: LeadDetail, hasOutboundAfterMeeting: boolean): IntentSuggestion {
  const motion = lead.motion || "outbound_prospecting";
  const hasInbound = !!lead.last_inbound_at;
  const hasOutbound = !!lead.last_outbound_at;
  const hasMeeting = (lead as any).meeting_summary_count > 0 || lead.has_future_meeting;

  // Meeting logged, no follow-up sent → post_meeting_recap
  if (hasMeeting && !hasOutboundAfterMeeting) {
    return { intent: "post_meeting_recap", reason: "Meeting logged — no follow-up sent yet" };
  }

  // Meeting logged AND outbound after meeting → closing nudge / follow-up
  if (hasMeeting && hasOutboundAfterMeeting) {
    if (lead.stage === "closing") {
      return { intent: "closing_nudge", reason: "Deal in closing stage" };
    }
    return { intent: "follow_up", reason: "Post-meeting follow-up already sent" };
  }

  // Reply detected → reply to thread
  if (hasInbound && motion === "inbound_response") {
    return { intent: "reply_to_thread", reason: "Inbound reply detected" };
  }

  // Inbound lead (source) → inbound response
  if (["contact_form", "gmail_inbound", "referral"].includes(lead.source_type || "")) {
    if (!hasOutbound) {
      return { intent: "inbound_response", reason: "Inbound lead — first response" };
    }
    if (hasInbound) {
      return { intent: "reply_to_thread", reason: "Ongoing conversation" };
    }
  }

  // Nurture motion
  if (motion === "nurture") {
    return { intent: "nurture_email", reason: "Lead in nurture mode" };
  }

  // Default: follow-up
  return { intent: "follow_up", reason: "Next cadence step" };
}

function deriveLinkedInIntent(lead: LeadDetail): IntentSuggestion {
  const hasOutbound = !!lead.last_outbound_at;
  if (!hasOutbound) {
    return { intent: "connection_request", reason: "No prior outreach" };
  }
  return { intent: "follow_up_message", reason: "Follow up on prior contact" };
}

function deriveWhatsAppIntent(lead: LeadDetail): IntentSuggestion {
  if (lead.has_future_meeting) {
    return { intent: "meeting_reminder", reason: "Upcoming meeting" };
  }
  return { intent: "quick_follow_up", reason: "Quick touchpoint" };
}

// ============================================
// Main Component
// ============================================

export default function DraftsTab({ lead, onUpdate }: DraftsTabProps) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [channel, setChannel] = useState<Channel>("email");
  const [generatedContent, setGeneratedContent] = useState("");
  const [generatedSubject, setGeneratedSubject] = useState("");
  const [composerNote, setComposerNote] = useState("");
  const [knowledgeUsed, setKnowledgeUsed] = useState(false);
  const [hasOutboundAfterMeeting, setHasOutboundAfterMeeting] = useState(false);
  const { runTask, isLoading: isGenerating } = useAITask();

  // Dialog state for full composer
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDialogActionKey, setEmailDialogActionKey] = useState<string | undefined>(undefined);

  // Auto-intent
  const autoSuggestion = useMemo(() => {
    switch (channel) {
      case "email": return deriveEmailIntent(lead, hasOutboundAfterMeeting);
      case "linkedin": return deriveLinkedInIntent(lead);
      case "whatsapp": return deriveWhatsAppIntent(lead);
    }
  }, [channel, lead, hasOutboundAfterMeeting]);

  const [selectedIntent, setSelectedIntent] = useState<ComposerIntent>(autoSuggestion.intent);

  // Sync selected intent when auto-suggestion changes
  useEffect(() => {
    setSelectedIntent(autoSuggestion.intent);
  }, [autoSuggestion.intent]);

  // Check if outbound exists after last meeting
  useEffect(() => {
    const checkOutboundAfterMeeting = async () => {
      try {
        const [interactions, packs] = await Promise.all([
          getLeadInteractions(lead.id),
          getLeadMeetingPacks(lead.id),
        ]);
        if (packs.length > 0) {
          const lastMeetingDate = new Date(packs[0].meeting_date || packs[0].created_at);
          const hasOutbound = interactions.some(
            (i) => (i.type === "email_outbound" || i.type === "note") &&
              new Date(i.occurred_at) > lastMeetingDate
          );
          setHasOutboundAfterMeeting(hasOutbound);
        }
      } catch (err) {
        console.error("Failed to check outbound after meeting:", err);
      }
    };
    checkOutboundAfterMeeting();
  }, [lead.id]);

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

  // ============================================
  // Build Context
  // ============================================

  const buildLeadContext = () => {
    return [
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
      composerNote && `User Instructions: ${composerNote}`,
    ].filter(Boolean).join("\n");
  };

  const buildLinkedInContext = () => {
    return [
      lead.industry && `Industry: ${lead.industry}`,
      lead.country && `Location: ${lead.country}`,
      lead.initial_message && `Their message: ${lead.initial_message}`,
      lead.personal_notes && `Notes: ${lead.personal_notes}`,
      composerNote && `Instructions: ${composerNote}`,
    ].filter(Boolean).join(". ") || `B2B sales outreach for ${lead.company}`;
  };

  // ============================================
  // Generate Handlers
  // ============================================

  const handleGenerate = async () => {
    // For email channel, open full EmailActionDialog composer
    if (channel === "email") {
      const actionKey = EMAIL_INTENT_TO_ACTION_KEY[selectedIntent as EmailIntent] || "send_pre_2_followup";
      setEmailDialogActionKey(actionKey);
      setShowEmailDialog(true);
      return;
    }

    // For LinkedIn/WhatsApp: keep inline generation
    try {
      const motionOverride = selectedIntent === "post_meeting_recap" ? "post_meeting" as const
        : selectedIntent === "closing_nudge" ? "closing" as const
        : selectedIntent === "nurture_email" ? "nurture" as const
        : null;

      const intentOverride = INTENT_TO_AI_TASK[selectedIntent as ComposerIntent] || null;

      const pipelineResult = await generateDraft({
        lead_id: lead.id,
        channel: channel,
        instructions: composerNote.trim() || null,
        motion_override: motionOverride,
        override_intent: intentOverride,
      });

      const taskType = pipelineResult.recommended_intent;
      const payload: Record<string, unknown> = {
        lead_context: buildLeadContext(),
        meeting_link: lead.meeting_link || "",
        lead_id: lead.id,
        custom_instructions: composerNote.trim() || undefined,
      };

      if (taskType === "linkedin_connect" || taskType === "linkedin_followup") {
        payload.prospect_name = lead.name;
        payload.title = lead.job_title || "";
        payload.company = lead.company;
        payload.context = buildLinkedInContext();
      }

      if (channel === "whatsapp") {
        payload.custom_instructions = ((payload.custom_instructions as string) || "") +
          "\n\nIMPORTANT: Write a short, natural WhatsApp message. Keep it under 100 words. No subject line. No signature block. Max 3-5 short paragraphs. Conversational tone. Optional emoji allowed but keep it professional.";
      }

      const result = await runTask(taskType, payload);
      if (result.ok && result.content) {
        setGeneratedContent(result.content);
        setKnowledgeUsed(!!(result.raw as any)?.knowledge_context_used);
        setGeneratedSubject("");
      }
    } catch (err) {
      console.error("[DraftsTab] Generation error:", err);
      toast.error("Failed to generate draft");
    }
  };

  // ============================================
  // Actions
  // ============================================

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generatedContent);
    toast.success("Copied to clipboard");
  };

  const saveAsDraft = async () => {
    try {
      await saveDraft(lead.id, {
        channel: channel,
        draft_type: selectedIntent,
        subject: generatedSubject || undefined,
        body_text: generatedContent,
        to_recipient: lead.email,
      });
      toast.success("Draft saved");
      setGeneratedContent("");
      setGeneratedSubject("");
      loadDrafts();
    } catch {
      toast.error("Failed to save draft");
    }
  };

  // ============================================
  // Intent Options per Channel
  // ============================================

  const getIntentOptions = (): { value: string; label: string; disabled?: boolean }[] => {
    switch (channel) {
      case "email": {
        const options = Object.entries(EMAIL_INTENT_LABELS).map(([value, label]) => ({
          value,
          label,
          disabled: value === "post_meeting_recap" && hasOutboundAfterMeeting,
        }));
        return options;
      }
      case "linkedin":
        return Object.entries(LINKEDIN_INTENT_LABELS).map(([value, label]) => ({ value, label }));
      case "whatsapp":
        return Object.entries(WHATSAPP_INTENT_LABELS).map(([value, label]) => ({ value, label }));
    }
  };

  const charLimit = CHAR_LIMITS[selectedIntent];
  const isShortForm = channel === "linkedin" || channel === "whatsapp";

  return (
    <div className="space-y-6">
      {/* Composer Panel */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Composer
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Channel Toggle */}
          <ToggleGroup
            type="single"
            value={channel}
            onValueChange={(v) => v && setChannel(v as Channel)}
            className="w-full justify-start border rounded-lg p-1 bg-muted/30"
          >
            <ToggleGroupItem value="email" className="flex-1 gap-1.5 data-[state=on]:bg-background data-[state=on]:shadow-sm">
              <Mail className="h-4 w-4" />
              Email
            </ToggleGroupItem>
            <ToggleGroupItem value="whatsapp" className="flex-1 gap-1.5 data-[state=on]:bg-background data-[state=on]:shadow-sm">
              <MessageSquare className="h-4 w-4" />
              WhatsApp
            </ToggleGroupItem>
            <ToggleGroupItem value="linkedin" className="flex-1 gap-1.5 data-[state=on]:bg-background data-[state=on]:shadow-sm">
              <Linkedin className="h-4 w-4" />
              LinkedIn
            </ToggleGroupItem>
          </ToggleGroup>

          {/* Intent Selector */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Suggested:</span>
              <Badge variant="secondary" className="text-xs">{autoSuggestion.reason}</Badge>
            </div>
            <Select value={selectedIntent} onValueChange={(v) => setSelectedIntent(v as ComposerIntent)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getIntentOptions().map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
                    {opt.label}
                    {opt.disabled && " (already sent)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Optional Note */}
          <div>
            <Input
              value={composerNote}
              onChange={(e) => setComposerNote(e.target.value)}
              placeholder="Optional note (e.g., mention the conference, focus on pricing...)"
              className="text-sm"
            />
          </div>

          {/* Generate Button */}
          <Button onClick={handleGenerate} disabled={isGenerating} className="w-full">
            {isGenerating ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            Generate Draft
          </Button>
        </CardContent>
      </Card>

      {/* Generated Content */}
      {generatedContent && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">
                  {channel === "email" ? "📧" : channel === "linkedin" ? "🔗" : "💬"}{" "}
                  {EMAIL_INTENT_LABELS[selectedIntent as EmailIntent] ||
                   LINKEDIN_INTENT_LABELS[selectedIntent as LinkedInIntent] ||
                   WHATSAPP_INTENT_LABELS[selectedIntent as WhatsAppIntent]}
                </CardTitle>
                {knowledgeUsed ? (
                  <Badge variant="outline" className="text-xs text-primary border-primary/30">
                    <Database className="h-3 w-3 mr-1" />
                    KB
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    <AlertCircle className="h-3 w-3 mr-1" />
                    No KB
                  </Badge>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={copyToClipboard}>
                  <Copy className="h-3.5 w-3.5 mr-1" />
                  Copy
                </Button>
                <Button size="sm" onClick={saveAsDraft}>
                  <Save className="h-3.5 w-3.5 mr-1" />
                  Save
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {channel === "email" && (
              <Input
                type="text"
                value={generatedSubject}
                onChange={(e) => setGeneratedSubject(e.target.value)}
                placeholder="Subject line..."
                className="text-sm"
              />
            )}
            <div className="relative">
              <Textarea
                value={generatedContent}
                onChange={(e) => setGeneratedContent(e.target.value)}
                rows={isShortForm ? 5 : 10}
                className={cn("text-sm", isShortForm && "font-normal")}
              />
              {charLimit && (
                <div className={cn(
                  "absolute bottom-2 right-3 text-xs",
                  generatedContent.length > charLimit ? "text-destructive" : "text-muted-foreground"
                )}>
                  {generatedContent.length}/{charLimit}
                </div>
              )}
            </div>
            {/* Send via Gmail for email channel */}
            {channel === "email" && (
              <div className="flex gap-2 justify-end">
                <SendEmailButton
                  to={lead.email}
                  subject={generatedSubject || ""}
                  body={generatedContent}
                  leadId={lead.id}
                  onSent={() => {
                    onUpdate();
                    loadDrafts();
                    setGeneratedContent("");
                    setGeneratedSubject("");
                  }}
                  variant="default"
                  size="sm"
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Saved Drafts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saved Drafts</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground text-sm">Loading...</p>
          ) : drafts.length === 0 ? (
            <p className="text-muted-foreground text-center py-4 text-sm">No drafts saved yet</p>
          ) : (
            <SavedDraftsList
              drafts={drafts}
              lead={lead}
              onDraftUpdate={loadDrafts}
              onEditDraft={(draft) => {
                setGeneratedContent(draft.body_text);
                setGeneratedSubject(draft.subject || "");
                setSelectedIntent((draft.draft_type || "follow_up") as ComposerIntent);
                setChannel(draft.channel === "linkedin" ? "linkedin" : "email");
              }}
            />
          )}
        </CardContent>
      </Card>

      {/* Email Action Dialog — full composer */}
      <EmailActionDialog
        lead={lead}
        actionKey={emailDialogActionKey}
        open={showEmailDialog}
        onOpenChange={(open) => {
          setShowEmailDialog(open);
        }}
        onSuccess={() => {
          onUpdate();
          loadDrafts();
        }}
        initialInstructions={composerNote}
      />
    </div>
  );
}

// ============================================
// Saved Drafts List (simplified)
// ============================================

interface SavedDraftsListProps {
  drafts: Draft[];
  lead: LeadDetail;
  onDraftUpdate: () => void;
  onEditDraft: (draft: Draft) => void;
}

function SavedDraftsList({ drafts, lead, onDraftUpdate, onEditDraft }: SavedDraftsListProps) {
  const handleMarkAsSent = async (draftId: string) => {
    try {
      await updateDraftStatus(draftId, "sent");
      toast.success("Marked as sent");
      onDraftUpdate();
    } catch {
      toast.error("Failed to update status");
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "sent":
        return <Badge className="bg-green-500/10 text-green-600 text-xs">Sent</Badge>;
      case "skipped":
        return <Badge variant="outline" className="text-muted-foreground text-xs">Skipped</Badge>;
      case "saved":
        return <Badge variant="secondary" className="text-xs">Saved</Badge>;
      default:
        return <Badge variant="outline" className="text-xs">Draft</Badge>;
    }
  };

  return (
    <div className="space-y-3">
      {drafts.map((draft) => (
        <div key={draft.id} className="p-3 border rounded-lg bg-background">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <Badge variant="outline" className="text-xs">{draft.channel}</Badge>
            <Badge variant="secondary" className="text-xs">{draft.draft_type.replace(/_/g, " ")}</Badge>
            {getStatusBadge(draft.status)}
            <span className="text-xs text-muted-foreground ml-auto">
              {format(new Date(draft.created_at), "MMM d, h:mm a")}
            </span>
          </div>
          {draft.subject && <p className="text-sm font-medium mb-1">{draft.subject}</p>}
          <p className="text-sm text-muted-foreground line-clamp-2">{draft.body_text}</p>
          <div className="flex gap-2 mt-2 flex-wrap">
            <Button variant="ghost" size="sm" onClick={() => {
              navigator.clipboard.writeText(draft.body_text);
              toast.success("Copied");
            }}>
              <Copy className="h-3 w-3 mr-1" />
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onEditDraft(draft)}>
              <Edit2 className="h-3 w-3 mr-1" />
              Edit
            </Button>
            {draft.channel === "email" && draft.status !== "sent" && (
              <SendEmailButton
                to={lead.email}
                subject={draft.subject || ""}
                body={draft.body_text}
                leadId={lead.id}
                draftId={draft.id}
                onSent={onDraftUpdate}
                variant="outline"
                size="sm"
              />
            )}
            {draft.status !== "sent" && (
              <Button variant="ghost" size="sm" onClick={() => handleMarkAsSent(draft.id)}>
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Mark Sent
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
