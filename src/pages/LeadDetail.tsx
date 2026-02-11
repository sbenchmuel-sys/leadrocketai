import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { getLeadDetail, LeadDetail as LeadDetailType, deleteLead } from "@/lib/supabaseQueries";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import TimelineTab from "@/components/lead/TimelineTab";
import DraftsTab from "@/components/lead/DraftsTab";
import UploadTab from "@/components/lead/UploadTab";
import RecommendationsTab from "@/components/lead/RecommendationsTab";
import MeetingsTab from "@/components/lead/MeetingsTab";
import MeetingPackHeader from "@/components/lead/MeetingPackHeader";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import LeadDetailHeader from "@/components/lead/LeadDetailHeader";

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<LeadDetailType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState("timeline");
  const { isConnected } = useGmailConnection();

  const handleDelete = async () => {
    if (!id) return;
    setIsDeleting(true);
    try {
      await deleteLead(id);
      toast.success("Lead deleted successfully");
      navigate("/dashboard/leads");
    } catch (err) {
      toast.error("Failed to delete lead");
    } finally {
      setIsDeleting(false);
    }
  };

  const loadLead = async () => {
    if (!id) return;
    try {
      const data = await getLeadDetail(id);
      setLead(data);
    } catch (err) {
      toast.error("Failed to load lead");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdate = async () => {
    await loadLead();
    setRefreshKey(prev => prev + 1);
  };

  useEffect(() => {
    loadLead();
  }, [id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Lead not found</p>
        <Button asChild className="mt-4">
          <Link to="/dashboard/leads">Back to Leads</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <LeadDetailHeader
        lead={lead}
        isConnected={isConnected}
        isDeleting={isDeleting}
        onDelete={handleDelete}
        onUpdate={handleUpdate}
        onSyncComplete={loadLead}
      />

      <MeetingPackHeader
        leadId={lead.id}
        leadName={lead.name}
        onNavigateToMeetings={() => setActiveTab("meetings")}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="drafts">Drafts</TabsTrigger>
          <TabsTrigger value="meetings">Meetings</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
          <TabsTrigger value="recommendations">Recommendations</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="mt-6">
          <TimelineTab leadId={lead.id} />
        </TabsContent>
        <TabsContent value="drafts" className="mt-6">
          <DraftsTab lead={lead} onUpdate={handleUpdate} />
        </TabsContent>
        <TabsContent value="meetings" className="mt-6">
          <MeetingsTab leadId={lead.id} leadEmail={lead.email} leadName={lead.name} onMilestonesAdded={handleUpdate} />
        </TabsContent>
        <TabsContent value="upload" className="mt-6">
          <UploadTab leadId={lead.id} onSuccess={handleUpdate} />
        </TabsContent>
        <TabsContent value="recommendations" className="mt-6">
          <RecommendationsTab key={refreshKey} lead={lead} onUpdate={handleUpdate} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
