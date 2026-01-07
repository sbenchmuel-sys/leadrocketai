import { useEffect, useState } from "react";
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
  updateLeadMilestoneStatus
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
  FileText
} from "lucide-react";
import { SendEmailButton } from "@/components/gmail/SendEmailButton";

interface MeetingsTabProps {
  leadId: string;
  leadEmail: string;
  leadName: string;
  onMilestonesAdded?: () => void;
}

export default function MeetingsTab({ leadId, leadEmail, leadName, onMilestonesAdded }: MeetingsTabProps) {
  const [meetingPacks, setMeetingPacks] = useState<MeetingPackItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [savingMilestonesId, setSavingMilestonesId] = useState<string | null>(null);
  const [savingDraftId, setSavingDraftId] = useState<string | null>(null);
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null);
  const [editedEmailBody, setEditedEmailBody] = useState("");

  const loadMeetingPacks = async () => {
    try {
      const data = await getLeadMeetingPacks(leadId);
      setMeetingPacks(data);
      // Auto-expand the first/most recent meeting
      if (data.length > 0 && expandedIds.size === 0) {
        setExpandedIds(new Set([data[0].id]));
      }
    } catch (err) {
      console.error("Failed to load meeting packs:", err);
      toast.error("Failed to load meetings");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMeetingPacks();
  }, [leadId]);

  const toggleExpanded = (id: string) => {
    const newSet = new Set(expandedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setExpandedIds(newSet);
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

  if (meetingPacks.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Calendar className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="font-medium text-lg mb-2">No Meetings Yet</h3>
          <p className="text-muted-foreground text-sm max-w-md mx-auto">
            When you generate a follow-up email or recap from meeting notes in the Drafts tab, 
            it will be saved here for future reference.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {meetingPacks.map((pack) => {
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
}
