import { useEffect, useState } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { getLeadDetail, LeadDetail as LeadDetailType, deleteLead } from "@/lib/supabaseQueries";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
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
import { EmailActionDialog } from "@/components/dashboard/EmailActionDialog";
import { useWorkspace } from "@/contexts/WorkspaceContext";

// Secondary panes — reachable from the "More" menu so the default view stays
// Timeline-only (Unit 3). Old in-app navigations that set these tab values
// (e.g. "see all meetings") still resolve to a valid pane, so nothing 404s.
const MORE_TABS: { value: string; label: string }[] = [
  { value: "drafts", label: "Saved drafts" },
  { value: "meetings", label: "Meetings" },
  { value: "partners", label: "People & partners" },
  { value: "context", label: "Lead context" },
  { value: "analysis", label: "Deep analysis" },
  { value: "upload", label: "Upload files" },
];

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<LeadDetailType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState("timeline");
  const moreActive = MORE_TABS.some(t => t.value === activeTab);
  const [showDraftDialog, setShowDraftDialog] = useState(false);
  const [draftActionKey, setDraftActionKey] = useState<string | undefined>(undefined);
  const location = useLocation();
  const originContext: "dashboard" | "leads" | "inbox" = location.state?.originContext || "dashboard";
  const { isConnected } = useGmailConnection();
  const { workspaceId } = useWorkspace();

  const backRoute = originContext === "leads" ? "/app/leads" : originContext === "inbox" ? "/app/inbox" : "/app";

  const handleDraftIt = () => {
    // Open the recommended draft in the review-and-send composer. The dialog
    // auto-generates from the lead's next_action_key (or its own sensible
    // default when there's no recommendation) and always ends in manual Send.
    setDraftActionKey(lead?.next_action_key ?? undefined);
    setShowDraftDialog(true);
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
        onDraftIt={handleDraftIt}
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
              {/* Everything else lives behind "More" so a rep sees Timeline by
                  default. The trigger shows the active pane's name when on one. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
                      moreActive
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {moreActive ? MORE_TABS.find(t => t.value === activeTab)?.label : "More"}
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {MORE_TABS.map(t => (
                    <DropdownMenuItem
                      key={t.value}
                      onSelect={() => setActiveTab(t.value)}
                      className={cn(activeTab === t.value && "bg-accent")}
                    >
                      {t.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
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
              {/* Review-only — composing happens via the header "Draft it". */}
              <DraftsTab lead={lead} onUpdate={handleUpdate} variant="review" />
            </TabsContent>
            <TabsContent value="meetings" className="mt-6">
              <MeetingsTab leadId={lead.id} leadEmail={lead.email} leadName={lead.name} onMilestonesAdded={handleUpdate} />
            </TabsContent>
            <TabsContent value="partners" className="mt-6">
              {workspaceId ? (
                <StakeholdersPartnersPanel
                  leadId={lead.id}
                  leadName={lead.name}
                  leadCompany={lead.company ?? null}
                  workspaceId={workspaceId}
                  onChanged={handleUpdate}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Loading workspace…</p>
              )}
            </TabsContent>
            <TabsContent value="context" className="mt-6">
              {workspaceId ? (
                <LeadContextPanel leadId={lead.id} workspaceId={workspaceId} onUpdate={handleUpdate} />
              ) : (
                <p className="text-sm text-muted-foreground">Loading workspace…</p>
              )}
            </TabsContent>
            <TabsContent value="analysis" className="mt-6">
              <RecommendationsTab key={refreshKey} lead={lead} onUpdate={handleUpdate} />
            </TabsContent>
            <TabsContent value="upload" className="mt-6">
              <UploadTab leadId={lead.id} onSuccess={handleUpdate} />
            </TabsContent>
          </Tabs>
        </div>

        {/* Sticky side panel — 1/3. Unit 3: Automation toggle + Latest Meeting
            only. Stakeholders/Partners and Lead Context moved to the More menu. */}
        <div className="hidden lg:block space-y-4">
          <LeadOverviewPanel
            lead={lead}
            onNavigateToMeetings={() => setActiveTab("meetings")}
            onUpdate={handleUpdate}
          />
        </div>
      </div>

      {/* One-tap "Draft it" — review-and-send composer (manual send only) */}
      <EmailActionDialog
        lead={lead}
        actionKey={draftActionKey}
        open={showDraftDialog}
        onOpenChange={setShowDraftDialog}
        onSuccess={handleUpdate}
      />
    </div>
  );
}
