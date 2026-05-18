import { useEffect, useState, useMemo } from "react";
import { format, parseISO } from "date-fns";
import { 
  getLeadMeetingPacks, 
  MeetingPackItem, 
  updateMeetingPack, 
  deleteMeetingPack,
  appendLeadMilestones,
  saveDraft,
  MilestoneItem,
  updateMeetingPackMilestoneStatus,
  updateLeadMilestoneStatus,
  getLeadMeetingSummaries,
  MeetingSummaryItem,
  createMeetingPack,
  getLeadDetail,
  getKnowledgeChunks
} from "@/lib/supabaseQueries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { 
  Calendar, 
  ChevronDown, 
  ChevronUp, 
  CheckCircle2, 
  Clock, 
  HelpCircle, 
  Mail, 
  Copy, 
  Save, 
  Trash2,
  PlusCircle,
  Loader2,
  FileText,
  Video,
  Users,
  Sparkles,
  RefreshCw,
  AlertTriangle
} from "lucide-react";
import { SendEmailButton } from "@/components/gmail/SendEmailButton";
import { useAITask } from "@/hooks/useAITask";
import { supabase } from "@/integrations/supabase/client";
import { UpcomingMeetingsSection } from "@/components/lead/UpcomingMeetingsSection";

interface MeetingsTabProps {
  leadId: string;
  leadEmail: string;
  leadName: string;
  onMilestonesAdded?: () => void;
}

interface Lead {
  id: string;
  name: string;
  company: string;
  email: string;
}

export default function MeetingsTab({ leadId, leadEmail, leadName, onMilestonesAdded }: MeetingsTabProps) {
  const [meetingPacks, setMeetingPacks] = useState<MeetingPackItem[]>([]);
  const [zoomSummaries, setZoomSummaries] = useState<MeetingSummaryItem[]>([]);
  const [capturedSummaries, setCapturedSummaries] = useState<any[]>([]);
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedZoomIds, setExpandedZoomIds] = useState<Set<string>>(new Set());
  const [savingMilestonesId, setSavingMilestonesId] = useState<string | null>(null);
  const [savingDraftId, setSavingDraftId] = useState<string | null>(null);
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null);
  const [editedEmailBody, setEditedEmailBody] = useState("");
  const [generatingRecapId, setGeneratingRecapId] = useState<string | null>(null);
  const [reassignSummary, setReassignSummary] = useState<MeetingSummaryItem | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string>("");
  const [isReassigning, setIsReassigning] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addDate, setAddDate] = useState(new Date().toISOString().split("T")[0]);
  const [addNotes, setAddNotes] = useState("");
  const [isAddingMeeting, setIsAddingMeeting] = useState(false);
  const { runTask } = useAITask();

  const extractJson = (content: string): string => {
    const trimmed = content.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    return (fenced?.[1] ?? trimmed).trim();
  };

  const handleAddMeetingSummary = async () => {
    if (!addNotes.trim()) {
      toast.error("Please enter meeting notes");
      return;
    }
    setIsAddingMeeting(true);
    try {
      const lead = await getLeadDetail(leadId);
      const leadContext = `Name: ${lead.name}\nCompany: ${lead.company}\nEmail: ${lead.email}\nStrategy: ${lead.strategy}\nStatus: ${lead.status}`;
      const kb = await getKnowledgeChunks(true);
      const knowledgeContext = kb.slice(0, 5).map(k => k.content.slice(0, 500)).join("\n---\n");
      const cleanedNotes = addNotes.split(/\n-{2,}|\nOn .* wrote:|\nFrom:|\n>|\nSent from/)[0].slice(0, 3000).trim();

      // Step 1: Generate recap
      toast.info("Step 1/2: Generating meeting recap...");
      const recapResult = await runTask("post_meeting_recap", {
        mode: lead.strategy,
        lead_context: leadContext,
        meeting_summary: cleanedNotes,
        knowledge_context: knowledgeContext,
        meeting_link: lead.meeting_link || "",
      });

      let recapData: Record<string, unknown> | null = null;
      if (recapResult.ok && recapResult.content) {
        try { recapData = JSON.parse(extractJson(recapResult.content)); } catch (e) { console.error("Failed to parse recap:", e); }
      }

      // Step 2: Extract milestones
      toast.info("Step 2/2: Extracting milestones...");
      const milestonesResult = await runTask("extract_milestones_risks", {
        lead_context: leadContext,
        interactions_text: cleanedNotes,
      });

      let milestonesData: { milestones: Array<{ description: string; status?: string; date?: string }>; risks: unknown[] } = { milestones: [], risks: [] };
      if (milestonesResult.ok && milestonesResult.content) {
        try { milestonesData = JSON.parse(extractJson(milestonesResult.content)); } catch (e) { console.error("Failed to parse milestones:", e); }
      }

      // Create meeting pack
      await createMeetingPack({
        lead_id: leadId,
        title: addTitle.trim() || `Meeting — ${format(parseISO(addDate), "MMM d, yyyy")}`,
        meeting_date: addDate,
        raw_notes: addNotes,
        internal_recap_bullets: (recapData?.internal_recap_bullets as string[]) || [],
        open_questions: (recapData?.open_questions as string[]) || [],
        milestones: (milestonesData.milestones || []).map(m => ({
          description: m.description,
          status: (m.status || "pending") as "completed" | "pending",
          date: m.date || null,
        })),
        follow_up_email_subject: (recapData?.customer_email as Record<string, string>)?.subject || null,
        follow_up_email_body: (recapData?.customer_email as Record<string, string>)?.body || null,
      });

      // Update lead stage to post_meeting
      await supabase.from("leads").update({ stage: "post_meeting", last_activity_at: new Date().toISOString() }).eq("id", leadId);

      toast.success("Meeting summary added with AI analysis!");
      setShowAddForm(false);
      setAddTitle("");
      setAddDate(new Date().toISOString().split("T")[0]);
      setAddNotes("");
      loadData();
      onMilestonesAdded?.();
    } catch (err) {
      console.error("Failed to add meeting summary:", err);
      toast.error("Failed to add meeting summary");
    } finally {
      setIsAddingMeeting(false);
    }
  };

  // Map to quickly find meeting pack for a processed zoom summary
  const zoomSummaryToPackMap = useMemo(() => {
    const map = new Map<string, MeetingPackItem>();
    meetingPacks.forEach(pack => {
      if (pack.source_meeting_summary_id) {
        map.set(pack.source_meeting_summary_id, pack);
      }
    });
    return map;
  }, [meetingPacks]);

  const loadData = async () => {
    try {
      const [packs, summaries, leadsResult] = await Promise.all([
        getLeadMeetingPacks(leadId),
        getLeadMeetingSummaries(leadId),
        supabase
          .from("leads")
          .select("id, name, company, email")
          .order("last_activity_at", { ascending: false })
          .limit(100)
      ]);
      setMeetingPacks(packs);
      setZoomSummaries(summaries);
      setAllLeads(leadsResult.data || []);
      // Auto-expand the first/most recent meeting
      if (packs.length > 0 && expandedIds.size === 0) {
        setExpandedIds(new Set([packs[0].id]));
      }
      if (summaries.length > 0 && expandedZoomIds.size === 0) {
        setExpandedZoomIds(new Set([summaries[0].id]));
      }
    } catch (err) {
      console.error("Failed to load meetings:", err);
      toast.error("Failed to load meetings");
    } finally {
      setIsLoading(false);
    }
  };

  // Keep the old function name for compatibility with existing calls
  const loadMeetingPacks = loadData;

  useEffect(() => {
    loadData();
  }, [leadId]);

  const handleDeleteSummary = async (summaryId: string) => {
    if (!confirm("Are you sure you want to remove this meeting summary from this lead? This cannot be undone.")) {
      return;
    }

    try {
      const { error } = await supabase
        .from("meeting_summaries")
        .delete()
        .eq("id", summaryId);

      if (error) throw error;

      toast.success("Meeting summary removed");
      loadData();
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error("Failed to remove meeting summary");
    }
  };

  const handleReassignSummary = async () => {
    if (!reassignSummary || !selectedLeadId) return;

    setIsReassigning(true);
    try {
      const { error } = await supabase
        .from("meeting_summaries")
        .update({ lead_id: selectedLeadId })
        .eq("id", reassignSummary.id);

      if (error) throw error;

      toast.success("Meeting summary reassigned to another lead");
      setReassignSummary(null);
      setSelectedLeadId("");
      loadData();
    } catch (err) {
      console.error("Failed to reassign:", err);
      toast.error("Failed to reassign meeting summary");
    } finally {
      setIsReassigning(false);
    }
  };

  const toggleExpanded = (id: string) => {
    const newSet = new Set(expandedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setExpandedIds(newSet);
  };

  const toggleZoomExpanded = (id: string) => {
    const newSet = new Set(expandedZoomIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setExpandedZoomIds(newSet);
  };

  const generateRecapFromZoomSummary = async (summary: MeetingSummaryItem) => {
    if (!summary.summary_text) {
      toast.error("No summary text to process");
      return;
    }

    setGeneratingRecapId(summary.id);
    try {
      const result = await runTask("post_meeting_recap", {
        mode: "fast",
        lead_name: leadName,
        lead_email: leadEmail,
        meeting_summary: summary.summary_text,
        lead_id: leadId,
      });

      if (!result.ok || !result.content) {
        throw new Error(result.error || "AI processing failed");
      }

      // Parse the AI response
      const parsed = JSON.parse(result.content);
      
      // Create meeting pack with structured data
      await createMeetingPack({
        lead_id: leadId,
        title: summary.meeting_title || `Zoom Meeting — ${format(parseISO(summary.sent_at), "MMM d, yyyy")}`,
        meeting_date: summary.sent_at.split("T")[0],
        raw_notes: summary.summary_text,
        internal_recap_bullets: parsed.internal_recap_bullets || [],
        open_questions: parsed.open_questions || [],
        milestones: (parsed.milestones_from_meeting || []).map((m: { description: string; status?: string; date?: string }) => ({
          description: m.description,
          status: m.status || "pending",
          date: m.date || null,
        })),
        follow_up_email_subject: parsed.customer_email?.subject || null,
        follow_up_email_body: parsed.customer_email?.body || null,
        source_meeting_summary_id: summary.id,
      });

      // Mark the meeting summary as processed
      await supabase
        .from("meeting_summaries")
        .update({ followup_generated: true })
        .eq("id", summary.id);

      toast.success("Recap & follow-up generated!");
      loadData();
    } catch (err) {
      console.error("Failed to generate recap:", err);
      toast.error("Failed to generate recap & follow-up");
    } finally {
      setGeneratingRecapId(null);
    }
  };

  const handleAddMilestones = async (pack: MeetingPackItem) => {
    if (!pack.milestones.length) return;
    setSavingMilestonesId(pack.id);
    try {
      await appendLeadMilestones(leadId, pack.milestones);
      await updateMeetingPack(pack.id, { milestones_saved_to_lead: true });
      toast.success("Milestones added to lead");
      loadMeetingPacks();
      onMilestonesAdded?.();
    } catch (err) {
      console.error(err);
      toast.error("Failed to add milestones");
    } finally {
      setSavingMilestonesId(null);
    }
  };

  const handleSaveEmailAsDraft = async (pack: MeetingPackItem) => {
    if (!pack.follow_up_email_body) return;
    setSavingDraftId(pack.id);
    try {
      await saveDraft(leadId, {
        channel: "email",
        draft_type: "post_meeting_followup",
        subject: pack.follow_up_email_subject || `Follow-up: Meeting with ${leadName}`,
        body_text: pack.follow_up_email_body,
        to_recipient: leadEmail,
      });
      await updateMeetingPack(pack.id, { email_saved_as_draft: true });
      toast.success("Email saved as draft");
      loadMeetingPacks();
    } catch (err) {
      console.error(err);
      toast.error("Failed to save draft");
    } finally {
      setSavingDraftId(null);
    }
  };

  const handleDeleteMeeting = async (id: string) => {
    try {
      await deleteMeetingPack(id);
      toast.success("Meeting deleted");
      loadMeetingPacks();
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete meeting");
    }
  };

  const copyInternalNotes = (pack: MeetingPackItem) => {
    const text = [
      "## Internal Recap",
      ...pack.internal_recap_bullets.map(b => `• ${b}`),
      "",
      "## Open Questions",
      ...pack.open_questions.map(q => `• ${q}`),
      "",
      "## Milestones",
      ...pack.milestones.map(m => `• [${m.status}] ${m.description}${m.date ? ` (${m.date})` : ""}`),
    ].join("\n");
    navigator.clipboard.writeText(text);
    toast.success("Notes copied to clipboard");
  };

  const startEditingEmail = (pack: MeetingPackItem) => {
    setEditingEmailId(pack.id);
    setEditedEmailBody(pack.follow_up_email_body || "");
  };

  const saveEditedEmail = async (packId: string) => {
    try {
      await updateMeetingPack(packId, { follow_up_email_body: editedEmailBody });
      toast.success("Email updated");
      setEditingEmailId(null);
      loadMeetingPacks();
    } catch (err) {
      console.error(err);
      toast.error("Failed to update email");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const addMeetingForm = showAddForm && (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Add Meeting Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Title (optional)</label>
            <Input value={addTitle} onChange={e => setAddTitle(e.target.value)} placeholder="e.g. Discovery Call" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Date</label>
            <Input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Meeting Notes</label>
          <Textarea value={addNotes} onChange={e => setAddNotes(e.target.value)} placeholder="Paste meeting notes, key discussion points, and action items..." rows={8} />
        </div>
        <div className="flex gap-2">
          <Button onClick={handleAddMeetingSummary} disabled={isAddingMeeting || !addNotes.trim()}>
            {isAddingMeeting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
            {isAddingMeeting ? "Analyzing..." : "Add & Analyze"}
          </Button>
          <Button variant="outline" onClick={() => setShowAddForm(false)} disabled={isAddingMeeting}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );

  if (meetingPacks.length === 0 && zoomSummaries.length === 0 && !showAddForm) {
    return (
      <div className="space-y-6">
        <UpcomingMeetingsSection leadId={leadId} />
        <Card>
          <CardContent className="py-12 text-center">
            <Calendar className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="font-medium text-lg mb-2">No Meetings Yet</h3>
            <p className="text-muted-foreground text-sm max-w-md mx-auto mb-4">
              Add meeting summaries to trigger AI analysis — recap, milestones, and follow-up email generation.
            </p>
            <Button onClick={() => setShowAddForm(true)}>
              <PlusCircle className="h-4 w-4 mr-2" />
              Add Meeting Summary
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (meetingPacks.length === 0 && zoomSummaries.length === 0 && showAddForm) {
    return (
      <div className="space-y-6">
        <UpcomingMeetingsSection leadId={leadId} />
        {addMeetingForm}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <UpcomingMeetingsSection leadId={leadId} />
      {/* Add Meeting Summary button + form */}
      <div className="flex justify-end">
        {!showAddForm && (
          <Button variant="outline" onClick={() => setShowAddForm(true)}>
            <PlusCircle className="h-4 w-4 mr-2" />
            Add Meeting Summary
          </Button>
        )}
      </div>
      {addMeetingForm}
      {/* Zoom Meeting Summaries Section */}
      {zoomSummaries.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Video className="h-5 w-5 text-blue-500" />
            <h3 className="font-medium">Zoom Meeting Summaries</h3>
            <Badge variant="secondary" className="text-xs">{zoomSummaries.length}</Badge>
          </div>
          
          {zoomSummaries.map((summary) => {
            const isExpanded = expandedZoomIds.has(summary.id);
            const sentDate = format(parseISO(summary.sent_at), "MMM d, yyyy 'at' h:mm a");
            const linkedPack = zoomSummaryToPackMap.get(summary.id);
            const isProcessed = !!linkedPack;
            const isGenerating = generatingRecapId === summary.id;

            return (
              <Card key={summary.id} className="overflow-hidden border-blue-200 dark:border-blue-900">
                <Collapsible open={isExpanded} onOpenChange={() => toggleZoomExpanded(summary.id)}>
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Video className="h-5 w-5 text-blue-500" />
                          <div>
                            <CardTitle className="text-base">
                              {summary.meeting_title || "Zoom Meeting"}
                            </CardTitle>
                            <p className="text-sm text-muted-foreground mt-0.5">
                              {sentDate}
                              {summary.participants_emails.length > 0 && (
                                <span> • {summary.participants_emails.length} participant{summary.participants_emails.length !== 1 ? 's' : ''}</span>
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                            <Video className="h-3 w-3 mr-1" />
                            Zoom AI
                          </Badge>
                          {isProcessed && (
                            <Badge variant="secondary" className="text-xs bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300">
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              Processed
                            </Badge>
                          )}
                          {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                        </div>
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>

                  <CollapsibleContent>
                    <CardContent className="space-y-4 pt-0">
                      {/* Participants */}
                      {summary.participants_emails.length > 0 && (
                        <div className="space-y-2">
                          <h4 className="text-sm font-medium flex items-center gap-2">
                            <Users className="h-4 w-4 text-muted-foreground" />
                            Participants
                          </h4>
                          <div className="flex flex-wrap gap-1">
                            {summary.participants_emails.map((email, i) => (
                              <Badge key={i} variant="secondary" className="text-xs font-normal">
                                {email}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Show structured content if processed, otherwise show raw summary with generate button */}
                      {isProcessed && linkedPack ? (
                        <>
                          {/* Internal Recap */}
                          {linkedPack.internal_recap_bullets.length > 0 && (
                            <div className="space-y-2">
                              <h4 className="text-sm font-medium flex items-center gap-2">
                                <FileText className="h-4 w-4 text-primary" />
                                Internal Recap
                              </h4>
                              <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                                {linkedPack.internal_recap_bullets.map((bullet, i) => (
                                  <p key={i} className="text-sm flex gap-2">
                                    <span className="text-primary">•</span>
                                    {bullet}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Open Questions */}
                          {linkedPack.open_questions.length > 0 && (
                            <div className="space-y-2">
                              <h4 className="text-sm font-medium flex items-center gap-2">
                                <HelpCircle className="h-4 w-4 text-amber-500" />
                                Open Questions
                              </h4>
                              <div className="bg-amber-500/10 rounded-lg p-3 space-y-1">
                                {linkedPack.open_questions.map((q, i) => (
                                  <p key={i} className="text-sm flex gap-2">
                                    <span className="text-amber-500">?</span>
                                    {q}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Milestones */}
                          {linkedPack.milestones.length > 0 && (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <h4 className="text-sm font-medium flex items-center gap-2">
                                  <Clock className="h-4 w-4 text-blue-500" />
                                  Milestones
                                </h4>
                                {!linkedPack.milestones_saved_to_lead && (
                                  <Button 
                                    variant="outline" 
                                    size="sm" 
                                    onClick={() => handleAddMilestones(linkedPack)}
                                    disabled={savingMilestonesId === linkedPack.id}
                                  >
                                    {savingMilestonesId === linkedPack.id ? (
                                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                    ) : (
                                      <PlusCircle className="h-3 w-3 mr-1" />
                                    )}
                                    Add to Lead
                                  </Button>
                                )}
                              </div>
                              <div className="space-y-1">
                                {linkedPack.milestones.map((m, i) => (
                                  <div key={i} className="flex items-center gap-3 p-2 bg-muted/50 rounded">
                                    <Checkbox
                                      id={`zoom-milestone-${linkedPack.id}-${i}`}
                                      checked={m.status === "completed"}
                                      onCheckedChange={async (checked) => {
                                        try {
                                          await updateMeetingPackMilestoneStatus(linkedPack.id, i, !!checked);
                                          if (linkedPack.milestones_saved_to_lead) {
                                            await updateLeadMilestoneStatus(leadId, i, !!checked);
                                          }
                                          loadMeetingPacks();
                                          onMilestonesAdded?.();
                                        } catch (err) {
                                          console.error(err);
                                          toast.error("Failed to update milestone");
                                        }
                                      }}
                                    />
                                    <span className={`text-sm flex-1 ${m.status === "completed" ? "line-through text-muted-foreground" : ""}`}>
                                      {m.description}
                                    </span>
                                    {m.status === "completed" ? (
                                      <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200">
                                        Done
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className="text-xs">
                                        Pending
                                      </Badge>
                                    )}
                                    {m.date && <span className="text-xs text-muted-foreground">{m.date}</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Follow-up Email */}
                          {linkedPack.follow_up_email_body && (
                            <div className="space-y-2 pt-2 border-t">
                              <h4 className="text-sm font-medium flex items-center gap-2">
                                <Mail className="h-4 w-4 text-primary" />
                                Follow-up Email
                              </h4>
                              {linkedPack.follow_up_email_subject && (
                                <div className="flex items-center gap-2 text-sm">
                                  <span className="font-medium text-muted-foreground">Subject:</span>
                                  <span>{linkedPack.follow_up_email_subject}</span>
                                </div>
                              )}
                              <div className="bg-muted/50 rounded-lg p-3">
                                <pre className="text-sm whitespace-pre-wrap font-sans">{linkedPack.follow_up_email_body}</pre>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Button 
                                  variant="outline" 
                                  size="sm" 
                                  onClick={() => {
                                    navigator.clipboard.writeText(linkedPack.follow_up_email_body || "");
                                    toast.success("Email copied");
                                  }}
                                >
                                  <Copy className="h-3 w-3 mr-1" />
                                  Copy
                                </Button>
                                {!linkedPack.email_saved_as_draft && (
                                  <Button 
                                    size="sm" 
                                    onClick={() => handleSaveEmailAsDraft(linkedPack)}
                                    disabled={savingDraftId === linkedPack.id}
                                  >
                                    {savingDraftId === linkedPack.id ? (
                                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                    ) : (
                                      <Save className="h-3 w-3 mr-1" />
                                    )}
                                    Save as Draft
                                  </Button>
                                )}
                                <SendEmailButton
                                  to={leadEmail}
                                  subject={linkedPack.follow_up_email_subject || `Follow-up: Meeting with ${leadName}`}
                                  body={linkedPack.follow_up_email_body || ""}
                                />
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          {/* Raw Summary Text */}
                          {summary.summary_text && (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <h4 className="text-sm font-medium flex items-center gap-2">
                                  <FileText className="h-4 w-4 text-primary" />
                                  Meeting Summary
                                </h4>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    navigator.clipboard.writeText(summary.summary_text || "");
                                    toast.success("Summary copied to clipboard");
                                  }}
                                >
                                  <Copy className="h-3 w-3 mr-1" />
                                  Copy
                                </Button>
                              </div>
                              <div className="bg-muted/50 rounded-lg p-3 max-h-80 overflow-y-auto">
                                <pre className="text-sm whitespace-pre-wrap font-sans">{summary.summary_text}</pre>
                              </div>
                            </div>
                          )}

                          {/* Generate Recap & Follow-up Button */}
                          <div className="pt-2 border-t">
                            <Button
                              onClick={() => generateRecapFromZoomSummary(summary)}
                              disabled={isGenerating}
                              className="w-full"
                            >
                              {isGenerating ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  Generating Recap & Follow-up...
                                </>
                              ) : (
                                <>
                                  <Sparkles className="h-4 w-4 mr-2" />
                                  Generate Recap & Follow-up
                                </>
                              )}
                            </Button>
                          </div>
                        </>
                      )}

                      {/* Delete/Reassign Actions for Zoom Summary */}
                      <div className="pt-3 border-t flex items-center justify-between">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <AlertTriangle className="h-3 w-3" />
                          Wrong lead?
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReassignSummary(summary);
                              setSelectedLeadId("");
                            }}
                          >
                            <RefreshCw className="h-3 w-3 mr-1" />
                            Reassign
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSummary(summary.id);
                            }}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Remove
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Collapsible>
              </Card>
            );
          })}
        </div>
      )}

      {/* Manual Meeting Packs Section - exclude packs generated from Zoom summaries */}
      {(() => {
        const manualPacks = meetingPacks.filter(p => !p.source_meeting_summary_id);
        if (manualPacks.length === 0) return null;
        
        return (
        <div className="space-y-3">
          {zoomSummaries.length > 0 && (
            <div className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-primary" />
              <h3 className="font-medium">Meeting Notes & Follow-ups</h3>
              <Badge variant="secondary" className="text-xs">{manualPacks.length}</Badge>
            </div>
          )}
          
      {manualPacks.map((pack) => {
        const isExpanded = expandedIds.has(pack.id);
        const meetingDate = pack.meeting_date 
          ? format(parseISO(pack.meeting_date), "MMM d, yyyy")
          : format(parseISO(pack.created_at), "MMM d, yyyy");

        return (
          <Card key={pack.id} className="overflow-hidden">
            <Collapsible open={isExpanded} onOpenChange={() => toggleExpanded(pack.id)}>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Calendar className="h-5 w-5 text-primary" />
                      <div>
                        <CardTitle className="text-base">
                          {pack.title || `Meeting with ${leadName}`}
                        </CardTitle>
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {meetingDate} • {pack.milestones.length} milestones • {pack.open_questions.length} questions
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {pack.milestones_saved_to_lead && (
                        <Badge variant="secondary" className="text-xs">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          Milestones Saved
                        </Badge>
                      )}
                      {pack.email_saved_as_draft && (
                        <Badge variant="secondary" className="text-xs">
                          <Mail className="h-3 w-3 mr-1" />
                          Draft Saved
                        </Badge>
                      )}
                      {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                    </div>
                  </div>
                </CardHeader>
              </CollapsibleTrigger>

              <CollapsibleContent>
                <CardContent className="space-y-6 pt-0">
                  {/* Internal Recap */}
                  {pack.internal_recap_bullets.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium flex items-center gap-2">
                          <FileText className="h-4 w-4 text-primary" />
                          Internal Recap
                        </h4>
                        <Button variant="ghost" size="sm" onClick={() => copyInternalNotes(pack)}>
                          <Copy className="h-3 w-3 mr-1" />
                          Copy Notes
                        </Button>
                      </div>
                      <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                        {pack.internal_recap_bullets.map((bullet, i) => (
                          <p key={i} className="text-sm flex gap-2">
                            <span className="text-primary">•</span>
                            {bullet}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Open Questions */}
                  {pack.open_questions.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium flex items-center gap-2">
                        <HelpCircle className="h-4 w-4 text-amber-500" />
                        Open Questions
                      </h4>
                      <div className="bg-amber-500/10 rounded-lg p-3 space-y-1">
                        {pack.open_questions.map((q, i) => (
                          <p key={i} className="text-sm flex gap-2">
                            <span className="text-amber-500">?</span>
                            {q}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Milestones */}
                  {pack.milestones.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium flex items-center gap-2">
                          <Clock className="h-4 w-4 text-blue-500" />
                          Milestones
                        </h4>
                        {!pack.milestones_saved_to_lead && (
                          <Button 
                            variant="outline" 
                            size="sm" 
                            onClick={() => handleAddMilestones(pack)}
                            disabled={savingMilestonesId === pack.id}
                          >
                            {savingMilestonesId === pack.id ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <PlusCircle className="h-3 w-3 mr-1" />
                            )}
                            Add to Lead
                          </Button>
                        )}
                      </div>
                      <div className="space-y-1">
                        {pack.milestones.map((m, i) => (
                          <div key={i} className="flex items-center gap-3 p-2 bg-muted/50 rounded">
                            <Checkbox
                              id={`milestone-${pack.id}-${i}`}
                              checked={m.status === "completed"}
                              onCheckedChange={async (checked) => {
                                try {
                                  await updateMeetingPackMilestoneStatus(pack.id, i, !!checked);
                                  // Also update lead milestones if synced
                                  if (pack.milestones_saved_to_lead) {
                                    await updateLeadMilestoneStatus(leadId, i, !!checked);
                                  }
                                  loadMeetingPacks();
                                  onMilestonesAdded?.();
                                } catch (err) {
                                  console.error(err);
                                  toast.error("Failed to update milestone");
                                }
                              }}
                            />
                            <span className={`text-sm flex-1 ${m.status === "completed" ? "line-through text-muted-foreground" : ""}`}>
                              {m.description}
                            </span>
                            {m.status === "completed" ? (
                              <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200">
                                Done
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">
                                Pending
                              </Badge>
                            )}
                            {m.date && <span className="text-xs text-muted-foreground">{m.date}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Follow-up Email */}
                  {pack.follow_up_email_body && (
                    <div className="space-y-2 pt-2 border-t">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium flex items-center gap-2">
                          <Mail className="h-4 w-4 text-primary" />
                          Follow-up Email
                        </h4>
                      </div>
                      {pack.follow_up_email_subject && (
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium text-muted-foreground">Subject:</span>
                          <span>{pack.follow_up_email_subject}</span>
                        </div>
                      )}
                      
                      {editingEmailId === pack.id ? (
                        <div className="space-y-2">
                          <Textarea
                            value={editedEmailBody}
                            onChange={(e) => setEditedEmailBody(e.target.value)}
                            rows={8}
                            className="font-mono text-sm"
                          />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => saveEditedEmail(pack.id)}>
                              <Save className="h-3 w-3 mr-1" />
                              Save Changes
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setEditingEmailId(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="bg-muted/50 rounded-lg p-3">
                          <pre className="text-sm whitespace-pre-wrap font-sans">{pack.follow_up_email_body}</pre>
                        </div>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => {
                            navigator.clipboard.writeText(pack.follow_up_email_body || "");
                            toast.success("Email copied");
                          }}
                        >
                          <Copy className="h-3 w-3 mr-1" />
                          Copy
                        </Button>
                        {editingEmailId !== pack.id && (
                          <Button variant="outline" size="sm" onClick={() => startEditingEmail(pack)}>
                            Edit
                          </Button>
                        )}
                        {!pack.email_saved_as_draft && (
                          <Button 
                            size="sm" 
                            onClick={() => handleSaveEmailAsDraft(pack)}
                            disabled={savingDraftId === pack.id}
                          >
                            {savingDraftId === pack.id ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <Save className="h-3 w-3 mr-1" />
                            )}
                            Save as Draft
                          </Button>
                        )}
                        <SendEmailButton
                          to={leadEmail}
                          subject={pack.follow_up_email_subject || `Follow-up: Meeting with ${leadName}`}
                          body={pack.follow_up_email_body || ""}
                        />
                      </div>
                    </div>
                  )}

                  {/* Delete Action */}
                  <div className="pt-2 border-t flex justify-end">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                          <Trash2 className="h-3 w-3 mr-1" />
                          Delete Meeting
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete Meeting</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete this meeting record? This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteMeeting(pack.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        );
      })}
        </div>
        );
      })()}

      {/* Reassign Dialog for Zoom Summaries */}
      <Dialog open={!!reassignSummary} onOpenChange={() => setReassignSummary(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign Meeting Summary</DialogTitle>
            <DialogDescription>
              Move this meeting summary to a different lead
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="font-medium">{reassignSummary?.meeting_title || "Untitled Meeting"}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {reassignSummary && format(parseISO(reassignSummary.sent_at), "PPp")}
              </p>
              {reassignSummary?.participants_emails && reassignSummary.participants_emails.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs text-muted-foreground">Participants:</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {reassignSummary.participants_emails.map((email, i) => (
                      <Badge key={i} variant="secondary" className="text-xs">{email}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Select new lead:</p>
              <Select value={selectedLeadId} onValueChange={setSelectedLeadId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a lead..." />
                </SelectTrigger>
                <SelectContent>
                  {allLeads.filter(l => l.id !== leadId).map((lead) => (
                    <SelectItem key={lead.id} value={lead.id}>
                      {lead.name} - {lead.company}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setReassignSummary(null)}>
                Cancel
              </Button>
              <Button 
                onClick={handleReassignSummary} 
                disabled={!selectedLeadId || isReassigning}
              >
                {isReassigning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Reassign
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
