import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, RefreshCw, Check, ArrowRightLeft, Trash2 } from "lucide-react";
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

interface MatchedSummary {
  id: string;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  meeting_title: string | null;
  sent_at: string;
  summary_text: string | null;
  participants_emails: string[];
  lead_id: string | null;
  lead?: {
    id: string;
    name: string;
    company: string;
  };
}

interface Lead {
  id: string;
  name: string;
  company: string;
  email: string;
}

export function MatchedMeetingSummariesCard() {
  const { user } = useAuth();
  const [summaries, setSummaries] = useState<MatchedSummary[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSummary, setSelectedSummary] = useState<MatchedSummary | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string>("");
  const [isReassigning, setIsReassigning] = useState(false);

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]);

  const loadData = async () => {
    try {
      const [summariesResult, leadsResult] = await Promise.all([
        supabase
          .from("meeting_summaries")
          .select(`
            id,
            gmail_message_id,
            gmail_thread_id,
            meeting_title,
            sent_at,
            summary_text,
            participants_emails,
            lead_id,
            lead:leads (id, name, company)
          `)
          .eq("user_id", user!.id)
          .not("lead_id", "is", null)
          .order("sent_at", { ascending: false })
          .limit(50),
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
          participants_emails: s.participants_emails || [],
          lead: Array.isArray(s.lead) ? s.lead[0] : s.lead,
        }))
      );
      setLeads(leadsResult.data || []);
    } catch (err) {
      console.error("Failed to load matched summaries:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReassign = async () => {
    if (!selectedSummary || !selectedLeadId) return;

    setIsReassigning(true);
    try {
      const { error } = await supabase
        .from("meeting_summaries")
        .update({ lead_id: selectedLeadId })
        .eq("id", selectedSummary.id);

      if (error) throw error;

      toast.success("Meeting summary reassigned");
      setSelectedSummary(null);
      setSelectedLeadId("");
      loadData();
    } catch (err) {
      console.error("Failed to reassign:", err);
      toast.error("Failed to reassign meeting summary");
    } finally {
      setIsReassigning(false);
    }
  };

  const handleDelete = async (summaryId: string) => {
    if (!confirm("Are you sure you want to delete this meeting summary? This cannot be undone.")) {
      return;
    }

    try {
      const { error } = await supabase
        .from("meeting_summaries")
        .delete()
        .eq("id", summaryId);

      if (error) throw error;

      toast.success("Meeting summary deleted");
      loadData();
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error("Failed to delete meeting summary");
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
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-lg">Reassign Meeting Summaries</CardTitle>
          </div>
          <CardDescription>
            No matched meeting summaries to reassign
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">Reassign Meeting Summaries</CardTitle>
            </div>
            <Badge variant="outline">{summaries.length}</Badge>
          </div>
          <CardDescription>
            Fix incorrectly matched Zoom summaries by reassigning them to the correct lead
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
                  {summary.lead && (
                    <>
                      <span>→</span>
                      <span className="font-medium text-foreground">
                        {summary.lead.name}
                      </span>
                      <span className="text-xs">({summary.lead.company})</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 ml-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedSummary(summary);
                    setSelectedLeadId(summary.lead_id || "");
                  }}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Reassign
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(summary.id)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={!!selectedSummary} onOpenChange={() => setSelectedSummary(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign Meeting Summary</DialogTitle>
            <DialogDescription>
              Move this meeting summary to a different lead
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="font-medium">{selectedSummary?.meeting_title || "Untitled Meeting"}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {selectedSummary && format(new Date(selectedSummary.sent_at), "PPp")}
              </p>
              {selectedSummary?.lead && (
                <p className="text-sm mt-2">
                  Currently matched to: <span className="font-medium">{selectedSummary.lead.name}</span> ({selectedSummary.lead.company})
                </p>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Select new lead:</p>
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
              <Button 
                onClick={handleReassign} 
                disabled={!selectedLeadId || selectedLeadId === selectedSummary?.lead_id || isReassigning}
              >
                {isReassigning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <Check className="h-4 w-4 mr-2" />
                Reassign
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
