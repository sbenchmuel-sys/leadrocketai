import { useEffect, useState } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { getLeadDetail, LeadDetail as LeadDetailType, deleteLead } from "@/lib/supabaseQueries";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import TimelineTab from "@/components/lead/TimelineTab";
import DraftsTab from "@/components/lead/DraftsTab";
import UploadTab from "@/components/lead/UploadTab";
import RecommendationsTab from "@/components/lead/RecommendationsTab";
import MeetingsTab from "@/components/lead/MeetingsTab";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { useVisibilityRefresh } from "@/hooks/useVisibilityRefresh";
import LeadDetailHeader from "@/components/lead/LeadDetailHeader";
import LeadOverviewPanel from "@/components/lead/LeadOverviewPanel";
import LeadContextPanel from "@/components/lead/LeadContextPanel";
import StakeholdersPartnersPanel from "@/components/lead/StakeholdersPartnersPanel";
import { UnifiedIntelligenceCard } from "@/components/leads/UnifiedIntelligenceCard";
import { useWorkspace } from "@/contexts/WorkspaceContext";

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<LeadDetailType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState("timeline");
  const location = useLocation();
  const originContext: "dashboard" | "leads" | "inbox" = location.state?.originContext || "dashboard";
  const { isConnected } = useGmailConnection();
  const { workspaceId } = useWorkspace();

  const backRoute = originContext === "leads" ? "/app/leads" : originContext === "inbox" ? "/app/inbox" : "/app";

  const handleActionComplete = async () => {
    await loadLead();
    setRefreshKey(prev => prev + 1);
    navigate(backRoute);
  };

  const handleDelete = async () => {
    if (!id) return;
    setIsDeleting(true);
    try {
      await deleteLead(id);
      toast.success("Lead deleted successfully");
      navigate(backRoute);
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

  useVisibilityRefresh(() => {
    if (!id) return;
    loadLead();
    setRefreshKey(prev => prev + 1);
  });

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
          <Link to="/app/leads">Back to Leads</Link>
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
        originContext={originContext}
        onDelete={handleDelete}
        onUpdate={handleUpdate}
        onSyncComplete={loadLead}
        onCompose={() => setActiveTab("drafts")}
        onAddMeeting={() => setActiveTab("meetings")}
      />

      {/* Split layout: Main content + Side panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main content — 2/3 */}
        <div className="lg:col-span-2 space-y-6">
          {/* Canonical Intelligence — always visible above tabs */}
          <UnifiedIntelligenceCard lead={lead} mode="compact" onUpdated={handleUpdate} />

          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full justify-start">
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="drafts">Drafts</TabsTrigger>
              <TabsTrigger value="meetings">Meetings</TabsTrigger>
              <TabsTrigger value="upload">Upload</TabsTrigger>
              <TabsTrigger value="analysis">Deep Analysis</TabsTrigger>
            </TabsList>

            <TabsContent value="timeline" className="mt-6">
              <TimelineTab
                leadId={lead.id}
                onWhatsAppReply={handleUpdate}
                groupId={(lead as any).group_id ?? null}
                currentLead={{
                  id: lead.id,
                  name: lead.name,
                  email: lead.email,
                  company: lead.company,
                  stage: lead.stage,
                  motion: (lead as any).motion ?? undefined,
                  job_title: lead.job_title ?? null,
                  unsubscribed: (lead as any).unsubscribed === true,
                }}
              />
            </TabsContent>
            <TabsContent value="drafts" className="mt-6">
              <DraftsTab lead={lead} onUpdate={handleUpdate} onActionComplete={handleActionComplete} />
            </TabsContent>
            <TabsContent value="meetings" className="mt-6">
              <MeetingsTab leadId={lead.id} leadEmail={lead.email} leadName={lead.name} onMilestonesAdded={handleUpdate} />
            </TabsContent>
            <TabsContent value="upload" className="mt-6">
              <UploadTab leadId={lead.id} onSuccess={handleUpdate} />
            </TabsContent>
            <TabsContent value="analysis" className="mt-6">
              <RecommendationsTab key={refreshKey} lead={lead} onUpdate={handleUpdate} />
            </TabsContent>
          </Tabs>
        </div>

        {/* Sticky side panel — 1/3 */}
        <div className="hidden lg:block space-y-4">
          <LeadOverviewPanel
            lead={lead}
            onNavigateToMeetings={() => setActiveTab("meetings")}
            onUpdate={handleUpdate}
          />
          {workspaceId && (
            <StakeholdersPartnersPanel
              leadId={lead.id}
              leadName={lead.name}
              leadCompany={lead.company ?? null}
              workspaceId={workspaceId}
              onChanged={handleUpdate}
            />
          )}
          {workspaceId && (
            <LeadContextPanel
              leadId={lead.id}
              workspaceId={workspaceId}
              onUpdate={handleUpdate}
            />
          )}
        </div>
      </div>
    </div>
  );
}
