import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import { getLeadMeetingPacks, MeetingPackItem, MilestoneItem } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Calendar, Target, HelpCircle, ArrowRight, CheckCircle2 } from "lucide-react";

interface MeetingPackHeaderProps {
  leadId: string;
  leadName: string;
  onNavigateToMeetings: () => void;
}

export default function MeetingPackHeader({ leadId, leadName, onNavigateToMeetings }: MeetingPackHeaderProps) {
  const [lastMeeting, setLastMeeting] = useState<MeetingPackItem | null>(null);
  const [leadMilestones, setLeadMilestones] = useState<MilestoneItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        // Load meeting packs
        const packs = await getLeadMeetingPacks(leadId);
        if (packs.length > 0) {
          setLastMeeting(packs[0]);
        }

        // Load lead milestones for progress
        const { data: lead } = await supabase
          .from("leads")
          .select("milestones_json")
          .eq("id", leadId)
          .single();
        
        if (lead?.milestones_json) {
          setLeadMilestones(lead.milestones_json as unknown as MilestoneItem[]);
        }
      } catch (err) {
        console.error("Failed to load meeting pack header:", err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [leadId]);

  if (isLoading || !lastMeeting) {
    return null;
  }

  const meetingDate = lastMeeting.meeting_date 
    ? format(parseISO(lastMeeting.meeting_date), "MMM d")
    : format(parseISO(lastMeeting.created_at), "MMM d");

  const milestonesCount = lastMeeting.milestones.length;
  const questionsCount = lastMeeting.open_questions.length;
  const nextStep = lastMeeting.milestones.find(m => m.status === "pending")?.description;

  // Calculate progress from lead milestones
  const totalMilestones = leadMilestones.length;
  const completedMilestones = leadMilestones.filter(m => m.status === "completed").length;
  const progressPercent = totalMilestones > 0 ? (completedMilestones / totalMilestones) * 100 : 0;

  return (
    <Card className="bg-primary/5 border-primary/20">
      <CardContent className="py-3 px-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5 font-medium">
              <Calendar className="h-4 w-4 text-primary" />
              Last Meeting: {meetingDate}
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Target className="h-4 w-4" />
              {milestonesCount} milestone{milestonesCount !== 1 ? "s" : ""}
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <HelpCircle className="h-4 w-4" />
              {questionsCount} question{questionsCount !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Milestone Progress */}
          {totalMilestones > 0 && (
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <Progress value={progressPercent} className="w-24 h-2" />
              <span className="text-xs text-muted-foreground">
                {completedMilestones}/{totalMilestones}
              </span>
            </div>
          )}

          {nextStep && (
            <p className="text-sm text-muted-foreground flex-1 min-w-[200px]">
              <span className="font-medium text-foreground">Next:</span> {nextStep}
            </p>
          )}

          <Button variant="ghost" size="sm" onClick={onNavigateToMeetings} className="text-primary">
            View All Meetings
            <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
