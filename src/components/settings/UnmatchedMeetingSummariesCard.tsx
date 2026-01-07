import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, AlertCircle, Check, X, Users } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { format } from "date-fns";
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

interface SuggestedLead {
  lead_id: string;
  name: string;
  company: string;
  reason: string;
}

interface UnmatchedSummary {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  meeting_title: string | null;
  sent_at: string;
  summary_text: string | null;
  participants_emails: string[];
  suggested_leads: SuggestedLead[];
  created_at: string;
}

interface Lead {
  id: string;
  name: string;
  company: string;
  email: string;
}

export function UnmatchedMeetingSummariesCard() {
  const { user } = useAuth();
  const [summaries, setSummaries] = useState<UnmatchedSummary[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSummary, setSelectedSummary] = useState<UnmatchedSummary | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string>("");
  const [isResolving, setIsResolving] = useState(false);

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]);

  const loadData = async () => {
    try {
      const [summariesResult, leadsResult] = await Promise.all([
        supabase
          .from("unmatched_meeting_summaries")
          .select("*")
          .eq("user_id", user!.id)
          .is("resolved_at", null)
          .order("sent_at", { ascending: false }),
        supabase
          .from("leads")
          .select("id, name, company, email")
          .eq("owner_user_id", user!.id)
          .order("last_activity_at", { ascending: false })
          .limit(100),
      ]);

      if (summariesResult.error) throw summariesResult.error;
      if (leadsResult.error) throw leadsResult.error;

      setSummaries(
        (summariesResult.data || []).map((s) => ({
          ...s,
          suggested_leads: (Array.isArray(s.suggested_leads) ? s.suggested_leads : []) as unknown as SuggestedLead[],
        }))
      );
      setLeads(leadsResult.data || []);
    } catch (err) {
      console.error("Failed to load unmatched summaries:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResolve = async () => {
    if (!selectedSummary || !selectedLeadId) return;

    setIsResolving(true);
    try {
      // 1. Create meeting_summary linked to lead
      const { error: insertError } = await supabase
        .from("meeting_summaries")
        .insert({
          user_id: user!.id,
          lead_id: selectedLeadId,
          source: "zoom_email",
          gmail_message_id: selectedSummary.gmail_message_id,
          gmail_thread_id: selectedSummary.gmail_thread_id,
          sent_at: selectedSummary.sent_at,
          meeting_title: selectedSummary.meeting_title,
          summary_text: selectedSummary.summary_text,
          participants_emails: selectedSummary.participants_emails,
        });

      if (insertError) throw insertError;

      // 2. Mark unmatched as resolved
      const { error: updateError } = await supabase
        .from("unmatched_meeting_summaries")
        .update({
          resolved_at: new Date().toISOString(),
          resolved_lead_id: selectedLeadId,
        })
        .eq("id", selectedSummary.id);

      if (updateError) throw updateError;

      toast.success("Meeting summary matched to lead");
      setSelectedSummary(null);
      setSelectedLeadId("");
      loadData();
    } catch (err) {
      console.error("Failed to resolve:", err);
      toast.error("Failed to match meeting summary");
    } finally {
      setIsResolving(false);
    }
  };

  const handleDismiss = async (summaryId: string) => {
    try {
      const { error } = await supabase
        .from("unmatched_meeting_summaries")
        .delete()
        .eq("id", summaryId);

      if (error) throw error;
      toast.success("Summary dismissed");
      loadData();
    } catch (err) {
      console.error("Failed to dismiss:", err);
      toast.error("Failed to dismiss summary");
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (summaries.length === 0) {
    return null; // Don't show card if no unmatched summaries
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              <CardTitle className="text-lg">Unmatched Meeting Summaries</CardTitle>
            </div>
            <Badge variant="secondary">{summaries.length}</Badge>
          </div>
          <CardDescription>
            These Zoom meeting summaries couldn't be automatically matched to a lead
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {summaries.map((summary) => (
            <div
              key={summary.id}
              className="flex items-center justify-between p-3 rounded-lg border bg-card"
            >
              <div className="space-y-1 flex-1 min-w-0">
                <p className="font-medium truncate">
                  {summary.meeting_title || "Untitled Meeting"}
                </p>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{format(new Date(summary.sent_at), "MMM d, yyyy")}</span>
                  {summary.participants_emails.length > 0 && (
                    <>
                      <span>•</span>
                      <Users className="h-3 w-3" />
                      <span>{summary.participants_emails.length} participants</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 ml-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedSummary(summary)}
                >
                  Match
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDismiss(summary.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={!!selectedSummary} onOpenChange={() => setSelectedSummary(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Match Meeting Summary to Lead</DialogTitle>
            <DialogDescription>
              Select the lead this meeting belongs to
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="font-medium">{selectedSummary?.meeting_title || "Untitled Meeting"}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {selectedSummary && format(new Date(selectedSummary.sent_at), "PPp")}
              </p>
              {selectedSummary?.participants_emails && selectedSummary.participants_emails.length > 0 && (
                <p className="text-sm text-muted-foreground mt-2">
                  Participants: {selectedSummary.participants_emails.slice(0, 5).join(", ")}
                  {selectedSummary.participants_emails.length > 5 && ` +${selectedSummary.participants_emails.length - 5} more`}
                </p>
              )}
            </div>

            {selectedSummary?.suggested_leads && selectedSummary.suggested_leads.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Suggested Leads:</p>
                {selectedSummary.suggested_leads.map((suggestion) => (
                  <Button
                    key={suggestion.lead_id}
                    variant={selectedLeadId === suggestion.lead_id ? "default" : "outline"}
                    className="w-full justify-start"
                    onClick={() => setSelectedLeadId(suggestion.lead_id)}
                  >
                    <div className="text-left">
                      <p className="font-medium">{suggestion.name}</p>
                      <p className="text-xs opacity-70">{suggestion.company} • {suggestion.reason}</p>
                    </div>
                  </Button>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">Or select from all leads:</p>
              <Select value={selectedLeadId} onValueChange={setSelectedLeadId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a lead..." />
                </SelectTrigger>
                <SelectContent>
                  {leads.map((lead) => (
                    <SelectItem key={lead.id} value={lead.id}>
                      {lead.name} - {lead.company}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSelectedSummary(null)}>
                Cancel
              </Button>
              <Button onClick={handleResolve} disabled={!selectedLeadId || isResolving}>
                {isResolving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <Check className="h-4 w-4 mr-2" />
                Match to Lead
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
